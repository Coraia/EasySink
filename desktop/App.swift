import AppKit
import WebKit

@main
struct WiseReaderMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = ReaderApplication()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
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
    private var dataDirectory: URL!
    private var readyFile: URL!
    private var lastRoute = "#/"
    private var readingStorage: ReadingStorage!

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let args = CommandLine.arguments
            if let index = args.firstIndex(of: "--data-dir"), index + 1 < args.count {
                dataDirectory = URL(fileURLWithPath: args[index + 1], isDirectory: true)
            } else {
                dataDirectory = try FileManager.default.url(for: .applicationSupportDirectory,
                    in: .userDomainMask, appropriateFor: nil, create: true)
                    .appendingPathComponent("EasySink Candidate", isDirectory: true)
            }
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
        appMenu.addItem(withTitle: "关于 Wise Reader", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Wise Reader", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Wise Reader", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        let viewItem = NSMenuItem(); viewItem.submenu = view; menu.addItem(viewItem)
        NSApp.mainMenu = menu
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Wise Reader · 客户端候选"
        window.minSize = NSSize(width: 720, height: 560)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("ReaderWindow")
        window.center()
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
        alert.messageText = "Wise Reader · macOS 候选客户端"
        alert.informativeText = "复用现有阅读器；资料保存在本机独立目录。关闭窗口保留当前任务，退出应用会停止服务并保留恢复记录。\n\n这是本机体验候选，尚未完成正式发行验收。"
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "打开资料目录")
        if alert.runModal() == .alertSecondButtonReturn { NSWorkspace.shared.open(dataDirectory) }
    }

    @objc private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(); return true
    }

    private func startService() {
        guard service?.isRunning != true else { return }
        origin = nil
        token = UUID().uuidString + UUID().uuidString
        readyFile = dataDirectory.appendingPathComponent("desktop-ready-\(UUID().uuidString).json")
        launchTime = ProcessInfo.processInfo.systemUptime
        status.stringValue = "正在打开你的阅读空间…"
        status.isHidden = false
        retryButton.isHidden = true
        guard let resources = Bundle.main.resourceURL else { fail("应用资源不完整，请重新构建应用包。"); return }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("python/bin/python3")
        process.arguments = ["-I", resources.appendingPathComponent("app/scripts/desktop/backend.py").path,
            "--data-dir", dataDirectory.path, "--ready-file", readyFile.path, "--token", token]
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
                else { self.fail("阅读服务已停止。你的资料已保留，可重新连接继续阅读。") }
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
        if ProcessInfo.processInfo.systemUptime - launchTime > 40 {
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
        cookies.setCookie(cookie) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.verifySessionAndLoad(url, cookie: cookie)
            }
        }
    }

    private func verifySessionAndLoad(_ url: URL, cookie: HTTPCookie) async {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url.appendingPathComponent("health"))
        request.timeoutInterval = 5
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: [cookie])
        do {
            let (_, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  origin == url, service?.isRunning == true else {
                throw NSError(domain: "ReaderSession", code: 1)
            }
            record("session-verified")
            loadReader(url)
        } catch { fail("无法确认本机阅读会话，请重新连接。") }
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
        if service?.isRunning == true, let origin { loadReader(origin) }
        else { startService() }
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
            let panel = NSSavePanel(); panel.nameFieldStringValue = "wise-reader-experience.json"
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
            try? parentPipe?.fileHandleForWriting.close()
            service?.terminate()
        }
        return .terminateLater
    }

    private func record(_ event: String, _ fields: [String: Any] = [:]) {
        guard let dataDirectory else { return }
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
