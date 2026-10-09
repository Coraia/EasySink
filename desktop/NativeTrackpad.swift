import AppKit
import WebKit

/// Retain with the window; attach before load and detach before window teardown.
@MainActor
final class NativeTrackpad {
    private weak var webView: WKWebView?
    private var ownedURL: URL?
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var userScript: WKUserScript?
    private var hook = ""
    private var sequence = 0
    private var forwarding = false

    // Bounded native transport evidence, separate from forgeable DOM events.
    // NSEvents can also be programmatically generated: this is not human proof.
    private(set) var recentEvents: [[String: Any]] = []
    private(set) var deliveryError: String?
    var isAttached: Bool { monitor != nil }

    init() {}

    func attach(to webView: WKWebView, origin: URL) {
        detach()
        guard let scheme = origin.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = origin.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host),
              origin.user == nil, origin.password == nil else {
            deliveryError = "Native trackpad requires the owned loopback app URL"
            return
        }
        self.webView = webView
        ownedURL = origin
        hook = "__wiseReaderTrackpad_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        sequence = 0
        recentEvents.removeAll()
        deliveryError = nil
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .flagsChanged, .magnify, .rotate]) { [weak self] event in
            // Apple guarantees local monitor callbacks on the main thread.
            MainActor.assumeIsolated { self?.observe(event) }
            return event // DOM gating alone owns eligible horizontal page scroll.
        }
        guard monitor != nil else {
            deliveryError = "Unable to install local scroll monitor"
            return
        }
        let source = bootstrap(origin: origin)
        let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        userScript = script
        webView.configuration.userContentController.addUserScript(script)
        // Reattachment can also restore an already-loaded owned document.
        if owns(webView.url) { webView.evaluateJavaScript(source, completionHandler: nil) }
        let center = NotificationCenter.default
        for name in [NSApplication.didResignActiveNotification, NSWindow.didResignKeyNotification,
                     NSWindow.willCloseNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let eventWindow = note.object as? NSWindow
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if name == NSApplication.didResignActiveNotification ||
                        eventWindow === self.webView?.window {
                        self.interrupt("window-inactive")
                    }
                }
            })
        }
    }

    func detach() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let webView {
            send(["source": "desktop-detached"])
            if let userScript {
                // WKUserContentController has no single-script removal API.
                // Preserve every script owned by the host or another feature.
                let controller = webView.configuration.userContentController
                let remaining = controller.userScripts.filter { $0 !== userScript }
                controller.removeAllUserScripts()
                for script in remaining { controller.addUserScript(script) }
            }
        }
        forwarding = false
        userScript = nil
        webView = nil
        ownedURL = nil
        hook = ""
    }

    private func owns(_ url: URL?) -> Bool {
        guard let url, let ownedURL else { return false }
        func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }
        func path(_ url: URL) -> String { url.path.isEmpty ? "/" : url.path }
        return url.scheme?.lowercased() == ownedURL.scheme?.lowercased() &&
            url.host?.lowercased() == ownedURL.host?.lowercased() && port(url) == port(ownedURL) &&
            path(url) == path(ownedURL) && url.user == nil && url.password == nil
    }

    private func observe(_ event: NSEvent) {
        guard let webView, let window = webView.window, NSApp.isActive,
              event.window === window, window.isKeyWindow, window.isVisible,
              window.attachedSheet == nil, !webView.isLoading, owns(webView.url) else {
            interrupt("native-gate")
            return
        }
        guard event.modifierFlags.intersection([.control, .command, .option, .shift]).isEmpty,
              NSEvent.pressedMouseButtons == 0 else {
            interrupt("modified-input")
            return
        }
        if event.type == .magnify || event.type == .rotate {
            interrupt("zoom-or-rotate")
            return
        }
        guard event.type == .scrollWheel else { return }
        let phase = event.phase.rawValue, momentum = event.momentumPhase.rawValue
        guard phase != 0 || momentum != 0 else { return }
        let point = webView.convert(event.locationInWindow, from: nil)
        guard webView.bounds.contains(point) else { interrupt("outside-webview"); return }
        let bounds = webView.bounds
        let payload: [String: Any] = [
            "source": "macOS-NSEvent", "nativeTime": event.timestamp,
            "phase": phase, "momentum": momentum,
            // Match scripts/trackpad_lab/PhaseMonitor.swift, including natural scroll.
            "dx": -event.scrollingDeltaX, "dy": -event.scrollingDeltaY,
            "viewX": point.x - bounds.minX,
            "viewY": webView.isFlipped ? point.y - bounds.minY : bounds.maxY - point.y,
            "pageZoom": webView.pageZoom, "magnification": webView.magnification,
            "precise": event.hasPreciseScrollingDeltas,
            "directionInvertedFromDevice": event.isDirectionInvertedFromDevice,
            "ctrlKey": false, "metaKey": false, "altKey": false, "shiftKey": false,
            "buttons": 0, "sequence": sequence + 1
        ]
        sequence += 1
        forwarding = true
        recentEvents.append(payload)
        if recentEvents.count > 256 { recentEvents.removeFirst(recentEvents.count - 256) }
        send(payload)
    }

    private func interrupt(_ reason: String) {
        guard forwarding else { return }
        forwarding = false
        send(["source": "desktop-interrupted", "reason": reason])
    }

    private func send(_ payload: [String: Any]) {
        guard let webView, owns(webView.url), !hook.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let currentHook = hook
        webView.evaluateJavaScript("window[\(quoted(currentHook))]?.(\(json));") { [weak self] _, error in
            guard let self, self.hook == currentHook else { return }
            if let error { self.deliveryError = error.localizedDescription }
        }
    }

    private func quoted(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        return String(data: data, encoding: .utf8)!.dropFirst().dropLast().description
    }

    private func bootstrap(origin: URL) -> String {
        let path = origin.path.isEmpty ? "/" : origin.path
        return """
        (() => {
          const owned = new URL(\(quoted(origin.absoluteString)));
          const allowed = () => window === window.top && location.origin === owned.origin &&
            location.pathname === \(quoted(path));
          if (!allowed()) return;
          const key = \(quoted(hook));
          const capability = window.wiseReaderDesktop || {};
          capability.nativeTrackpad = true;
          const dispatch = detail => window.dispatchEvent(new CustomEvent('wise-reader-native-trackpad', { detail }));
          Object.defineProperty(window, 'wiseReaderDesktop', { configurable: true, writable: true, value: capability });
          window[key] = event => {
            if (!allowed() || window.wiseReaderDesktop !== capability) return;
            if (event.source === 'desktop-detached') {
              delete window[key];
              capability.nativeTrackpad = false; // Preserve host lifecycle hooks.
              dispatch(event);
              return;
            }
            if (event.source === 'macOS-NSEvent') {
              // AppKit points are independent of Retina backing pixels. DOM hit
              // testing uses CSS viewport coordinates, including page/pinch zoom.
              const viewport = window.visualViewport;
              const zoom = event.pageZoom || 1;
              const scale = viewport?.scale || event.magnification || 1;
              event.clientX = event.viewX / zoom / scale + (viewport?.offsetLeft || 0);
              event.clientY = event.viewY / zoom / scale + (viewport?.offsetTop || 0);
              event.dx /= zoom * scale;
              event.dy /= zoom * scale;
            }
            dispatch(event);
          };
          dispatch({ source: 'desktop-ready' });
        })();
        """
    }
}
