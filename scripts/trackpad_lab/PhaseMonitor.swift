import AppKit
import Foundation

// Read-only, scrollWheel-only observer, gated by this prototype's active client.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var active = false
    func set(_ value: Bool) { lock.lock(); active = value; lock.unlock() }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return active }
}
let gate = Gate()
setbuf(stdout, nil)
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() { gate.set(line == "on") }
    exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let monitor = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { event in
    guard gate.get() else { return } // Zero-delta ended events must still pass.
    guard event.modifierFlags.intersection([.control, .command, .option]).isEmpty else { return }
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
    guard ["Codex", "ChatGPT", "Google Chrome", "Microsoft Edge", "Safari"].contains(where: { front.hasPrefix($0) }) else { return }
    let phase = event.phase.rawValue, momentum = event.momentumPhase.rawValue
    guard phase != 0 || momentum != 0 else { return }
    let payload: [String: Any] = ["source": "macOS-NSEvent", "nativeTime": event.timestamp,
      "dx": -event.scrollingDeltaX, "dy": -event.scrollingDeltaY,
      "phase": phase, "momentum": momentum]
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
guard monitor != nil else { fputs("Scroll monitor unavailable\n", stderr); exit(2) }
print("{\"source\":\"monitor-ready\",\"mask\":\"scrollWheel\"}")
app.run()
