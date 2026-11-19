import Foundation

/// Persists allowlisted per-library reading state across loopback WebKit origins.
@MainActor
final class ReadingStorage {
    private struct LegacySnapshot: Decodable {
        let values: [String: String]
    }

    private let file: URL
    private(set) var values: [String: String] = [:]
    private(set) var initialized = false
    private(set) var writeFailed = false
    private var available = false

    // The writable policy follows every key produced by the current web client.
    // Older snapshots may contain retired keys; keep them opaque and intact.
    private static let keys = Set(["theme", "typography", "page-layout", "page-motion", "page-light",
        "speech-rate", "speech-voice", "last-document", "import-draft", "note-drafts-v3",
        "edition", "picturebook-demo", "picturebook-chinese", "picturebook-assistance",
        "picturebook-rate", "ai-reading-return"])
    private static let prefixes = ["book-chapter:", "position-pending:", "note-draft:", "grammar-open:",
        "jump:", "translation-jump:", "note-return:", "collection-meaning:",
        "picturebook-position:", "living-book-position:", "fox-story-position:",
        "children-book-chapter:"]

    init(directory: URL) {
        file = directory.appendingPathComponent("reading-storage.json")
        guard FileManager.default.fileExists(atPath: file.path) else {
            available = true
            return
        }
        do {
            let data = try Data(contentsOf: file)
            let decoded: [String: String]
            if let direct = try? JSONDecoder().decode([String: String].self, from: data) {
                decoded = direct
            } else {
                decoded = try JSONDecoder().decode(LegacySnapshot.self, from: data).values
            }
            guard Self.validMap(decoded) else { throw NSError(domain: "ReaderStorage", code: 1) }
            values = decoded
            initialized = true
            available = true
        } catch {
            writeFailed = true // Preserve unreadable files; bootstrap fails closed.
        }
    }

    static func accepts(_ key: String) -> Bool {
        safeKey(key) && (keys.contains(key) || prefixes.contains(where: key.hasPrefix))
    }

    private static func safeKey(_ key: String) -> Bool {
        !key.isEmpty && key.utf8.count < 160
    }

    private static func validMap(_ map: [String: String]) -> Bool {
        map.allSatisfy { safeKey($0.key) && $0.value.utf8.count <= 4_194_304 }
    }

    /// Replaces allowlisted values from the web snapshot while keeping retired opaque keys.
    @discardableResult func replace(_ incoming: [String: Any]) -> Bool {
        guard available else { return false }
        var decoded: [String: String] = [:]
        decoded.reserveCapacity(incoming.count)
        for (key, raw) in incoming {
            guard let text = raw as? String, Self.safeKey(key), text.utf8.count <= 4_194_304
                else { return false }
            decoded[key] = text
        }
        var merged = values.filter { !Self.accepts($0.key) }
        for (key, text) in decoded where Self.accepts(key) { merged[key] = text }
        if merged == values && initialized && !writeFailed { return true }
        values = merged
        return save()
    }

    private func save() -> Bool {
        do {
            let data = try JSONEncoder().encode(values)
            try data.write(to: file, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            initialized = true; writeFailed = false
            return true
        } catch { writeFailed = true; return false }
    }

    func bootstrap() -> String {
        let seed = available ? String(data: try! JSONEncoder().encode(values), encoding: .utf8)! : "null"
        let keys = String(data: try! JSONEncoder().encode(Array(Self.keys)), encoding: .utf8)!
        let prefixes = String(data: try! JSONEncoder().encode(Self.prefixes), encoding: .utf8)!
        return """
        (() => {
          const desktop = window.wiseReaderDesktop ||= {};
          const seed = \(seed), keys = new Set(\(keys)), prefixes = \(prefixes);
          const bytes = value => new TextEncoder().encode(value).length;
          const safeKey = key => typeof key === 'string' && key.length > 0 && bytes(key) < 160;
          const accepts = key => safeKey(key) &&
            (keys.has(key) || prefixes.some(prefix => key.startsWith(prefix)));
          const post = (kind, extra) => window.webkit.messageHandlers.readerLifecycle.postMessage({kind, ...extra});
          const report = message => {
            desktop.storageReady = false;
            desktop.storageError = message;
            try { post('storage-error', {message}); } catch {}
          };
          const clearProjection = () => {
            for (const key of Object.keys(localStorage)) if (key.startsWith('wr2:')) localStorage.removeItem(key);
          };
          const failClosed = message => {
            try { clearProjection(); } catch {}
            desktop.readLocal = () => null;
            desktop.persistLocal = key => { if (accepts(key)) throw new Error('Reading storage is unavailable'); };
            report(message);
          };
          if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
            failClosed('Reading storage could not be restored');
            return;
          }
          const current = {...seed};
          try {
            clearProjection();
            for (const [key, value] of Object.entries(current)) localStorage.setItem('wr2:' + key, value);
            desktop.persistLocal = (key, value) => {
              if (!accepts(key)) return;
              if (value !== null && (typeof value !== 'string' || bytes(value) > 4194304)) {
                report('Reading value exceeds the storage limit');
                throw new Error('Reading value exceeds the storage limit');
              }
              if (value === null) delete current[key]; else current[key] = value;
              post('storage-snapshot', {snapshot: {...current}});
              desktop.storageReady = true;
              desktop.storageError = null;
            };
            desktop.readLocal = () => ({...current});
            post('storage-snapshot', {snapshot: {...current}});
            desktop.storageReady = true;
            desktop.storageError = null;
          } catch {
            failClosed('Reading storage could not be restored');
          }
        })();
        """
    }
}
