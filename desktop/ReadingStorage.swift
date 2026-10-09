import Foundation

/// Only this library's versioned reading state crosses loopback origins.
@MainActor
final class ReadingStorage {
    private struct Snapshot: Codable, Equatable {
        let schema: Int
        let identity: String
        let revision: Int
        let values: [String: String]
    }

    private let file: URL
    private(set) var identity = ""
    private(set) var revision = 0
    private(set) var values: [String: String] = [:]
    private(set) var initialized = false
    private(set) var writeFailed = false
    private var available = false
    private static let maximumRevision = 9_007_199_254_740_991
    private static let keys = Set(["theme", "typography", "page-layout", "page-motion", "page-light",
        "speech-rate", "speech-voice", "last-document", "import-draft", "note-drafts-v3"])
    private static let prefixes = ["book-chapter:", "position-pending:", "note-draft:", "grammar-open:"]

    init(directory: URL) {
        file = directory.appendingPathComponent("reading-storage.json")
        let identityFile = directory.appendingPathComponent("reading-library-id")
        do {
            let data = FileManager.default.fileExists(atPath: file.path) ? try Data(contentsOf: file) : nil
            let saved = data.flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) }
            if !FileManager.default.fileExists(atPath: identityFile.path) {
                // The native file belongs to this supplied directory. Never infer
                // identity from unowned WebView storage or its old wr2 projection.
                let proposed = saved?.identity ?? UUID().uuidString.lowercased()
                guard UUID(uuidString: proposed) != nil else { throw invalidSnapshot() }
                do {
                    try Data(proposed.utf8).write(to: identityFile, options: [.withoutOverwriting])
                } catch {
                    // A duplicate host may have created the identity first.
                    guard FileManager.default.fileExists(atPath: identityFile.path) else { throw error }
                }
            }
            identity = try String(contentsOf: identityFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard UUID(uuidString: identity) != nil else { throw invalidSnapshot() }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: identityFile.path)
            if let saved {
                guard Self.valid(saved), saved.identity == identity else { throw invalidSnapshot() }
                values = saved.values; revision = saved.revision; initialized = true
            } else if let data {
                // Compatibility is limited to the earlier candidate's OWN file.
                let legacy = try JSONDecoder().decode([String: String].self, from: data)
                values = legacy.filter { Self.accepts($0.key) }
                guard values.values.allSatisfy({ $0.utf8.count <= 4_194_304 }) else { throw invalidSnapshot() }
                revision = 1
            }
            available = true
            if !initialized { _ = save() }
        } catch { writeFailed = true } // Preserve unreadable files; bootstrap fails closed.
    }

    private func invalidSnapshot() -> NSError { NSError(domain: "ReaderStorage", code: 1) }

    static func accepts(_ key: String) -> Bool {
        key.utf8.count < 160 && (keys.contains(key) || prefixes.contains(where: key.hasPrefix))
    }

    private static func valid(_ snapshot: Snapshot) -> Bool {
        snapshot.schema == 1 && snapshot.revision >= 0 && snapshot.revision <= maximumRevision &&
            UUID(uuidString: snapshot.identity) != nil && snapshot.values.allSatisfy {
                accepts($0.key) && $0.value.utf8.count <= 4_194_304
            }
    }

    private var snapshot: Snapshot { Snapshot(schema: 1, identity: identity, revision: revision, values: values) }

    /// App passes body["snapshot"] from storage-snapshot, or readLocal() on quit.
    /// Stale/cross-library/equal-revision conflicting snapshots cannot overwrite state.
    @discardableResult func replace(_ wrapper: [String: Any]) -> Bool {
        guard available, JSONSerialization.isValidJSONObject(wrapper),
              let data = try? JSONSerialization.data(withJSONObject: wrapper),
              let incoming = try? JSONDecoder().decode(Snapshot.self, from: data),
              Self.valid(incoming), incoming.identity == identity, incoming.revision >= revision else { return false }
        if incoming.revision == revision {
            guard incoming.values == values else { return false }
            if initialized && !writeFailed { return true }
        }
        // Retain the newest state in memory even if disk is temporarily unwritable.
        values = incoming.values; revision = incoming.revision
        return save()
    }

    private func save() -> Bool {
        do {
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: file, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            initialized = true; writeFailed = false
            return true
        } catch { writeFailed = true; return false }
    }

    func bootstrap() -> String {
        let seed = available ? String(data: try! JSONEncoder().encode(snapshot), encoding: .utf8)! : "null"
        let keys = String(data: try! JSONEncoder().encode(Array(Self.keys)), encoding: .utf8)!
        let prefixes = String(data: try! JSONEncoder().encode(Self.prefixes), encoding: .utf8)!
        return """
        (() => {
          const desktop = window.wiseReaderDesktop ||= {};
          const seed = \(seed), keys = new Set(\(keys)), prefixes = \(prefixes);
          const bytes = value => new TextEncoder().encode(value).length;
          const accepts = key => typeof key === 'string' && bytes(key) < 160 &&
            (keys.has(key) || prefixes.some(prefix => key.startsWith(prefix)));
          const valid = value => value && value.schema === 1 && value.identity === seed?.identity &&
            Number.isSafeInteger(value.revision) && value.revision >= 0 &&
            value.values && typeof value.values === 'object' && !Array.isArray(value.values) &&
            Object.entries(value.values).every(([key, text]) => accepts(key) &&
              typeof text === 'string' && bytes(text) <= 4194304);
          const equalValues = (a, b) => Object.keys(a).length === Object.keys(b).length &&
            Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
          const copy = value => JSON.parse(JSON.stringify(value));
          const report = message => {
            desktop.storageReady = false;
            desktop.storageError = message;
            try { window.webkit.messageHandlers.readerLifecycle.postMessage({kind:'storage-error', message}); } catch {}
          };
          const clearProjection = () => {
            for (const key of Object.keys(localStorage)) if (key.startsWith('wr2:')) localStorage.removeItem(key);
          };
          desktop.storageReady = false;
          desktop.readLocal = () => null;
          desktop.persistLocal = key => { if (accepts(key)) throw new Error('Reading storage is unavailable'); };
          let current = null, dirty = false, exhausted = false;
          const invalidKeys = new Set();
          try {
            if (!valid(seed)) throw new Error('Library storage identity is unavailable');
            const envelopeKey = 'wr-desktop-reading:v1:' + seed.identity;
            const raw = localStorage.getItem(envelopeKey);
            const browser = raw === null ? null : JSON.parse(raw);
            if (browser !== null && !valid(browser)) throw new Error('Library storage envelope is invalid');
            if (browser && browser.revision === seed.revision && !equalValues(browser.values, seed.values))
              throw new Error('Library storage revisions conflict');
            current = copy(browser && browser.revision > seed.revision ? browser : seed);
            // Raw wr2 keys have no library provenance. Never adopt them, including
            // transient jumps/return routes left by a different library at this port.
            clearProjection();
            localStorage.setItem(envelopeKey, JSON.stringify(current));
            for (const [key, value] of Object.entries(current.values)) localStorage.setItem('wr2:' + key, value);
            const post = () => window.webkit.messageHandlers.readerLifecycle.postMessage({kind:'storage-snapshot', snapshot:copy(current)});
            const durable = () => {
              if (dirty) localStorage.setItem(envelopeKey, JSON.stringify(current));
              dirty = false;
              post();
              desktop.storageReady = true;
              desktop.storageError = null;
            };
            desktop.persistLocal = (key, value) => {
              if (!accepts(key)) return;
              if (value !== null && (typeof value !== 'string' || bytes(value) > 4194304)) {
                invalidKeys.add(key);
                report('Reading value exceeds the storage limit');
                throw new Error('Reading value exceeds the storage limit');
              }
              if (current.revision >= Number.MAX_SAFE_INTEGER) {
                exhausted = true;
                report('Reading storage revision is exhausted');
                throw new Error('Reading storage revision is exhausted');
              }
              invalidKeys.delete(key);
              const values = {...current.values};
              if (value === null) delete values[key]; else values[key] = value;
              current = {...current, revision:current.revision + 1, values};
              dirty = true;
              try { durable(); } catch (error) {
                // Keep the newer in-memory values and previous durable envelope.
                // A subsequent edit/readLocal can retry after space is available.
                report('Reading snapshot could not be persisted');
                throw error;
              }
            };
            desktop.readLocal = () => {
              if (invalidKeys.size || exhausted) return null;
              try { durable(); return copy(current); }
              catch { report('Reading snapshot could not be persisted'); return null; }
            };
            durable();
          } catch {
            // Never expose another library's raw keys after failed bootstrap,
            // nor return {} and let Quit wipe the last known native snapshot.
            try { clearProjection(); } catch {}
            desktop.readLocal = () => null;
            desktop.persistLocal = key => { if (accepts(key)) throw new Error('Reading storage is unavailable'); };
            report('Reading storage could not be restored');
          }
        })();
        """
    }
}
