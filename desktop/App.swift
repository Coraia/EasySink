import AppKit
import Darwin
import WebKit

@main
struct WiseReaderMain {
    static func main() {
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        let profile = DesktopBuildConfiguration.profile
        let configuration: LaunchConfiguration
        switch LaunchPolicy.resolve(arguments: CommandLine.arguments, homeDirectory: home,
            profile: profile, actualBundleIdentifier: Bundle.main.bundleIdentifier,
            declaredFlavor: Bundle.main.object(forInfoDictionaryKey: "EasySinkBuildFlavor") as? String) {
        case .run(let value):
            configuration = value
        case .help(let message):
            FileHandle.standardOutput.write(Data(message.utf8))
            return
        case .failure(let message):
            FileHandle.standardError.write(Data((message + "\n").utf8))
            Darwin.exit(64)
        }
        let instanceLock: NativeInstanceLock
        do {
            if profile.flavor != .diagnostic {
                try FileManager.default.createDirectory(at: configuration.dataDirectory,
                    withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            }
            instanceLock = try NativeInstanceLock.acquire(directory: configuration.dataDirectory)
        } catch NativeInstanceLockError.alreadyRunning {
            FileHandle.standardError.write(Data("This EasySink data root is already open.\n".utf8))
            Darwin.exit(73)
        } catch {
            FileHandle.standardError.write(Data(("Unable to acquire the native instance lock: \(error)\n").utf8))
            Darwin.exit(74)
        }
        let application = NSApplication.shared
        let delegate = ReaderApplication(configuration: configuration)
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime((delegate, instanceLock)) {}
    }
}

@MainActor
final class ReaderApplication: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var status: NSTextField!
    private var retryButton: NSButton!
    private var service: Process?
    private var parentPipe: Pipe?
    private var logHandle: FileHandle?
    private var readyTimer: Timer?
    private var origin: URL?
    private var token = ""
    private var terminating = false
    private var preparingQuit = false
    private var launchTime = ProcessInfo.processInfo.systemUptime
    private var nativeInput: NativeTrackpad?
    private let dataDirectory: URL
    private let profile: DesktopBuildProfile
    private var readyFile: URL!
    private var lastRoute = "#/"
    private var readingStorage: ReadingStorage!
    private var sessionCookie: HTTPCookie?
    private var wakeCheckPending = false
    private var runtimeRegistration: Process?

    init(configuration: LaunchConfiguration) {
        self.dataDirectory = configuration.dataDirectory
        self.profile = configuration.profile
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try FileManager.default.createDirectory(at: dataDirectory,
                withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            readingStorage = ReadingStorage(directory: dataDirectory)
            if let data = try? Data(contentsOf: dataDirectory.appendingPathComponent("window-state.json")),
               let state = try? JSONSerialization.jsonObject(with: data) as? [String: String],
               let route = state["route"], route.hasPrefix("#/") {
                lastRoute = route
            }
            makeMenu()
            makeWindow()
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake),
                name: NSWorkspace.didWakeNotification, object: nil)
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(willSleep),
                name: NSWorkspace.willSleepNotification, object: nil)
            record("launch")
            startService()
        } catch {
            let alert = NSAlert()
            alert.messageText = "无法准备阅读资料目录"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 \(profile.productName)", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 \(profile.productName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 \(profile.productName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"),
            ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let editItem = NSMenuItem(); editItem.submenu = edit; menu.addItem(editItem)
        let view = NSMenu(title: "窗口")
        view.addItem(withTitle: "显示阅读窗口", action: #selector(showWindow), keyEquivalent: "0")
        let full = view.addItem(withTitle: "进入全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        view.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        view.addItem(.separator())
        view.addItem(withTitle: "保存体验记录…", action: #selector(exportDiagnostics), keyEquivalent: "")
        view.addItem(withTitle: "连接本机识别资源…", action: #selector(connectOCRRuntime), keyEquivalent: "")
        let viewItem = NSMenuItem(); viewItem.submenu = view; menu.addItem(viewItem)
        NSApp.mainMenu = menu
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "候选"
        window.title = "\(profile.productName) · \(version) · \(profile.flavor.rawValue)"
        window.isReleasedWhenClosed = false
        window.delegate = self
        if !window.setFrameUsingName("ReaderWindow", force: true) {
            // AppKit frames are points. Include the title bar in the fitted
            // frame instead of treating physical display pixels as content.
            let visible = NSScreen.main?.visibleFrame ?? window.frame
            let size = NSSize(width: min(1200, visible.width * 0.9),
                              height: min(860, visible.height * 0.9))
            window.setFrame(NSRect(x: visible.midX - size.width / 2,
                                   y: visible.midY - size.height / 2,
                                   width: size.width, height: size.height), display: false)
        }
        fitWindowToVisibleScreen()
        window.setFrameAutosaveName("ReaderWindow")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.add(self, name: "readerLifecycle")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window.contentView!.addSubview(webView)
        status = NSTextField(wrappingLabelWithString: "正在打开你的阅读空间…")
        status.alignment = .center
        status.font = .systemFont(ofSize: 18)
        status.translatesAutoresizingMaskIntoConstraints = false
        retryButton = NSButton(title: "重新连接", target: self, action: #selector(retryService))
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.isHidden = true
        window.contentView!.addSubview(status)
        window.contentView!.addSubview(retryButton)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 620),
            retryButton.centerXAnchor.constraint(equalTo: status.centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 18)
        ])
        showWindow()
    }

    @objc private func about() {
        let alert = NSAlert()
        alert.messageText = "\(profile.productName) · macOS \(profile.flavor.rawValue)"
        alert.informativeText = "复用现有阅读器；资料保存在本机独立目录。关闭窗口保留当前任务，退出应用会停止服务并保留恢复记录。\n\n这是本机体验候选，尚未完成正式发行验收。"
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "打开资料目录")
        if alert.runModal() == .alertSecondButtonReturn { NSWorkspace.shared.open(dataDirectory) }
    }

    @objc private func showWindow() {
        fitWindowToVisibleScreen()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func fitWindowToVisibleScreen() {
        guard let window, !window.styleMask.contains(.fullScreen),
              !NSScreen.screens.isEmpty else { return }
        let frame = window.frame
        // Keep a saved frame on the display it overlaps most. If that display
        // disappeared, choose the nearest remaining display, then clamp.
        let screen = NSScreen.screens.max { a, b in
            func score(_ screen: NSScreen) -> CGFloat {
                let visible = screen.visibleFrame
                let intersection = frame.intersection(visible)
                if !intersection.isNull { return intersection.width * intersection.height }
                return -hypot(frame.midX - visible.midX, frame.midY - visible.midY)
            }
            return score(a) < score(b)
        }!
        let visible = screen.visibleFrame
        window.minSize = NSSize(width: min(640, visible.width), height: min(460, visible.height))
        let width = min(max(frame.width, window.minSize.width), visible.width)
        let height = min(max(frame.height, window.minSize.height), visible.height)
        let fitted = NSRect(x: min(max(frame.minX, visible.minX), visible.maxX - width),
                            y: min(max(frame.minY, visible.minY), visible.maxY - height),
                            width: width, height: height)
        if fitted != frame { window.setFrame(fitted, display: true) }
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) {
        fitWindowToVisibleScreen()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        // Update the minimum while moving between displays without snapping a
        // window mid-drag; restored/reopened frames are clamped above.
        guard let visible = window?.screen?.visibleFrame else { return }
        window.minSize = NSSize(width: min(640, visible.width), height: min(460, visible.height))
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(); return true
    }

    private func startService() {
        guard service?.isRunning != true else { return }
        readyTimer?.invalidate()
        try? parentPipe?.fileHandleForWriting.close()
        try? logHandle?.close()
        if let readyFile { try? FileManager.default.removeItem(at: readyFile) }
        origin = nil
        sessionCookie = nil
        token = UUID().uuidString + UUID().uuidString
        readyFile = dataDirectory.appendingPathComponent("desktop-ready-\(UUID().uuidString).json")
        launchTime = ProcessInfo.processInfo.systemUptime
        status.stringValue = "正在打开你的阅读空间…"
        status.isHidden = false
        retryButton.isHidden = true
        guard let resources = Bundle.main.resourceURL else { fail("应用资源不完整，请重新安装客户端。"); return }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("python/bin/python3")
        process.arguments = ["-I", resources.appendingPathComponent("app/scripts/desktop/backend.py").path,
            "--data-dir", dataDirectory.path, "--launch-flavor", profile.flavor.rawValue,
            "--bundle-id", profile.bundleIdentifier, "--root-id", profile.rootID,
            "--ready-file", readyFile.path, "--token", token]
        process.currentDirectoryURL = dataDirectory
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        let pipe = Pipe(); parentPipe = pipe; process.standardInput = pipe
        let logURL = dataDirectory.appendingPathComponent("backend.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        logHandle = try? FileHandle(forWritingTo: logURL)
        logHandle?.seekToEndOfFile()
        process.standardOutput = logHandle
        process.standardError = logHandle
        process.terminationHandler = { [weak self] process in
            Task { @MainActor [weak self] in
                guard let self, self.service === process else { return }
                self.readyTimer?.invalidate()
                self.record("service-exit", ["code": process.terminationStatus])
                if self.terminating { NSApp.reply(toApplicationShouldTerminate: true) }
                else if process.terminationStatus == 73 {
                    self.fail("这个阅读资料库已在另一个窗口中打开。请使用已有窗口，或先退出另一个实例。")
                } else { self.fail("阅读服务已停止。你的资料已保留，可重新连接继续阅读。") }
            }
        }
        service = process
        do {
            try process.run()
            record("service-start", ["pid": process.processIdentifier])
            readyTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.checkReady() }
            }
        } catch { fail("应用未能启动内置运行时：\(error.localizedDescription)") }
    }

    private func checkReady() {
        if ProcessInfo.processInfo.systemUptime - launchTime > 55 {
            readyTimer?.invalidate()
            fail("启动未完成。请查看资料目录中的 backend.log，再重新连接。")
            service?.terminate()
            return
        }
        guard let data = try? Data(contentsOf: readyFile),
              let ready = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              ready["token"] as? String == token,
              ready["pid"] as? Int32 == service?.processIdentifier,
              let address = ready["url"] as? String, let url = URL(string: address),
              url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { return }
        readyTimer?.invalidate()
        origin = url
        record("backend-ready")
        let cookies = webView.configuration.websiteDataStore.httpCookieStore
        guard let cookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/",
            .name: ready["cookie_name"] as? String ?? "wr_desktop", .value: token, HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            HTTPCookiePropertyKey("SameSite"): "Strict"]) else { fail("无法建立本机阅读会话。"); return }
        sessionCookie = cookie
        let expectedToken = token
        cookies.setCookie(cookie) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.token == expectedToken, !self.terminating else { return }
                await self.verifySessionAndLoad(url, cookie: cookie)
            }
        }
    }

    private func verifySessionAndLoad(_ url: URL, cookie: HTTPCookie, reloadReader: Bool = true) async {
        guard let expectedService = service, expectedService.isRunning, !terminating else { return }
        let expectedToken = token
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url.appendingPathComponent("health"))
        request.timeoutInterval = 5
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: [cookie])
        do {
            let (data, response) = try await session.data(for: request)
            guard service === expectedService, token == expectedToken, !terminating else { return }
            let health = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  health?["ok"] as? Bool == true, origin == url, expectedService.isRunning else {
                throw NSError(domain: "ReaderSession", code: 1)
            }
            record(reloadReader ? "session-verified" : "wake-session-verified")
            if reloadReader { loadReader(url) }
        } catch {
            guard service === expectedService, token == expectedToken, !terminating else { return }
            fail("无法确认本机阅读会话，请重新连接。")
        }
    }

    @objc private func willSleep() { record("system-will-sleep") }

    @objc private func didWake() {
        record("system-did-wake")
        fitWindowToVisibleScreen()
        guard !terminating, !preparingQuit, !wakeCheckPending,
              let origin, let sessionCookie, service?.isRunning == true else { return }
        wakeCheckPending = true
        Task { @MainActor in
            defer { wakeCheckPending = false }
            // A healthy wake keeps the live page, selection and unsaved draft.
            // No conversion, paid operation or backend is automatically restarted.
            await verifySessionAndLoad(origin, cookie: sessionCookie, reloadReader: false)
        }
    }

    private func loadReader(_ url: URL) {
        webView.configuration.userContentController.removeAllUserScripts()
        nativeInput?.detach()
        let native = NativeTrackpad()
        native.attach(to: webView, origin: url)
        nativeInput = native
        let jsonOrigin = String(data: try! JSONSerialization.data(withJSONObject: [url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))]), encoding: .utf8)!
        let script = """
        (() => {
          if (location.origin !== \(jsonOrigin)[0]) return;
          \(readingStorage.bootstrap())
          const emit = (kind) => window.webkit.messageHandlers.readerLifecycle.postMessage({kind, route: location.hash || '#/'});
          window.addEventListener('hashchange', () => emit('route'));
          let reported = '';
          const observer = new MutationObserver(() => {
            const reader = document.querySelector('#article');
            const ready = document.querySelector('.reader[data-ready="true"]');
            const shelf = document.querySelector('#new-reading');
            const state = ready ? 'reader-ready' : reader?.textContent.trim() ? 'reader-visible' : shelf ? 'shelf-visible' : '';
            if (state && state !== reported) { reported = state; requestAnimationFrame(() => emit(state)); }
          });
          observer.observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['data-ready']});
        })();
        """
        webView.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.fragment = String(lastRoute.dropFirst())
        webView.load(URLRequest(url: components.url!))
    }

    private func isOwned(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isOwned(message.frameInfo.request.url),
            let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        if kind == "storage-snapshot", let snapshot = body["snapshot"] as? [String: Any] {
            if !readingStorage.replace(snapshot) { record("storage-write-failed") }
            return
        }
        if kind == "storage-error" {
            record("storage-bootstrap-error")
            return
        }
        if let route = body["route"] as? String, route.hasPrefix("#/"), route.count < 500 {
            lastRoute = route
            if let data = try? JSONSerialization.data(withJSONObject: ["route": route]) {
                try? data.write(to: dataDirectory.appendingPathComponent("window-state.json"), options: .atomic)
            }
        }
        if ["shelf-visible", "reader-visible", "reader-ready"].contains(kind) {
            status.isHidden = true; retryButton.isHidden = true
            record(kind)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let isLocalBlob = action.request.url?.absoluteString.hasPrefix("blob:\(origin?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? "invalid")/") == true
        if action.shouldPerformDownload && (isOwned(action.request.url) || isLocalBlob) {
            decisionHandler(.download); return
        }
        if isOwned(action.request.url) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, let url = action.request.url,
            ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard isOwned(frame.request.url) else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard isOwned(frame.request.url) else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("页面连接暂时中断，请重新连接。") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The web application now owns loading/error feedback on every route.
        // Interactive shelf/reader milestones are recorded separately.
        if isOwned(webView.url) {
            status.isHidden = true; retryButton.isHidden = true
            record("web-shell-loaded")
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        record("web-content-exit")
        fail("阅读窗口暂时中断，资料已保留。请重新连接。")
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard isOwned(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    @objc private func retryService() {
        if service?.isRunning == true, let origin, let sessionCookie {
            let expectedToken = token
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(sessionCookie) { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self, self.token == expectedToken, !self.terminating else { return }
                    await self.verifySessionAndLoad(origin, cookie: sessionCookie)
                }
            }
        }
        else { startService() }
    }

    @objc private func connectOCRRuntime() {
        guard runtimeRegistration?.isRunning != true, !terminating, !preparingQuit else { return }
        let panel = NSOpenPanel()
        panel.title = "连接已准备的本机识别资源"
        panel.message = "选择资源目录中的 runtime.json。资源为可选项，不影响已有书籍和基础词注；本操作不下载模型。连接后退出并重新打开应用生效。"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self, let selected = panel.url,
                  let resources = Bundle.main.resourceURL else { return }
            let process = Process()
            process.executableURL = resources.appendingPathComponent("python/bin/python3")
            process.arguments = ["-I", "-B", resources.appendingPathComponent("app/scripts/desktop/runtime.py").path,
                "--data-dir", self.dataDirectory.path, "--register", selected.path]
            process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
            process.standardInput = FileHandle.nullDevice
            let log = self.dataDirectory.appendingPathComponent("ocr-registration.log")
            FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
            guard let handle = try? FileHandle(forWritingTo: log) else {
                self.fail("无法保存识别资源配置，请检查资料目录的可用空间。"); return
            }
            process.standardOutput = handle; process.standardError = handle
            self.runtimeRegistration = process
            process.terminationHandler = { [weak self] process in
                try? handle.close()
                Task { @MainActor [weak self] in
                    guard let self, !self.terminating else { return }
                    let alert = NSAlert()
                    alert.messageText = process.terminationStatus == 0 ? "本机识别资源已连接" : "识别资源尚未准备好"
                    alert.informativeText = process.terminationStatus == 0
                        ? "退出并重新打开应用后生效。请保留资源目录；阅读资料和 AI 设置保持原样。"
                        : "请选择完整的本机识别资源。你可以继续基本阅读和查词；资料目录中的 ocr-registration.log 保留了详细原因。"
                    alert.beginSheetModal(for: self.window)
                }
            }
            do { try process.run() }
            catch { try? handle.close(); self.fail("无法连接本机识别资源，请重新安装完整客户端后再试。") }
        }
    }

    @objc private func exportDiagnostics() {
        guard isOwned(webView.url) else { return }
        Task { @MainActor in
            let script = """
            const root = document.querySelector('.reader');
            const parse = value => { try { return JSON.parse(value || 'null'); } catch { return null; } };
            return {
              viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
              reading: {firstSourceMs: Number(root?.dataset.firstSourceMs || 0), readyMs: Number(root?.dataset.readyMs || 0),
                pageIndex: Number(root?.dataset.pageIndex || 0), pageCount: Number(root?.dataset.pageCount || 0)},
              trackpadMode: root?.dataset.trackpadMode,
              curlMetrics: parse(root?.dataset.curlMetrics),
              nativeGestures: parse(root?.dataset.nativeGestures),
              nativeCounts: parse(root?.dataset.nativeTrackpad),
              measuredAt: new Date().toISOString()
            };
            """
            guard let result = try? await webView.callAsyncJavaScript(script, arguments: [:],
                in: nil, contentWorld: .page) as? [String: Any] else { return }
            var report = result
            report["nativeEvents"] = nativeInput?.recentEvents ?? []
            report["nativeDeliveryError"] = nativeInput?.deliveryError ?? NSNull()
            report["os"] = ProcessInfo.processInfo.operatingSystemVersionString
            report["evidenceBoundary"] = "Native events may be generated. Human trackpad acceptance must be recorded separately. No book text or credentials included."
            guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) else { return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = "easysink-experience.json"
            panel.beginSheetModal(for: window) { response in
                if response == .OK, let url = panel.url { try? data.write(to: url, options: .atomic) }
            }
        }
    }

    private func fail(_ text: String) {
        status.stringValue = text; status.isHidden = false; retryButton.isHidden = false
        record("failure", ["message": text])
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateLater }
        guard service?.isRunning == true else { return .terminateNow }
        guard !preparingQuit else { return .terminateCancel }
        preparingQuit = true
        Task { @MainActor in
            if isOwned(webView.url) {
                do {
                    let result = try await webView.callAsyncJavaScript(
                        "return window.wiseReaderDesktop?.prepareToClose ? await window.wiseReaderDesktop.prepareToClose() : true;",
                        arguments: [:], in: nil, contentWorld: .page)
                    if result as? Bool == false { throw NSError(domain: "ReaderSave", code: 1) }
                    let snapshot = try await webView.callAsyncJavaScript(
                        "return window.wiseReaderDesktop?.readLocal?.() ?? null;",
                        arguments: [:], in: nil, contentWorld: .page)
                    guard let values = snapshot as? [String: Any], readingStorage.replace(values) else {
                        throw NSError(domain: "ReaderStorage", code: 1)
                    }
                } catch {
                    preparingQuit = false
                    NSApp.reply(toApplicationShouldTerminate: false)
                    let alert = NSAlert()
                    alert.messageText = "还未确认阅读记录已保存"
                    alert.informativeText = "请稍后重试退出。你仍可继续阅读，未保存的笔记草稿保留在本机。"
                    alert.runModal()
                    return
                }
            }
            terminating = true
            nativeInput?.detach()
            record("quit-requested")
            if service?.isRunning != true {
                NSApp.reply(toApplicationShouldTerminate: true)
                return
            }
            try? parentPipe?.fileHandleForWriting.close()
            service?.terminate()
        }
        return .terminateLater
    }

    private func record(_ event: String, _ fields: [String: Any] = [:]) {
        var row = fields
        row["event"] = event
        row["elapsed_ms"] = (ProcessInfo.processInfo.systemUptime - launchTime) * 1000
        row["time"] = ISO8601DateFormatter().string(from: Date())
        let url = dataDirectory.appendingPathComponent("desktop-events.jsonl")
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        if let file = try? FileHandle(forWritingTo: url) {
            file.seekToEndOfFile(); file.write(data); file.write(Data([10])); try? file.close()
        }
    }
}
