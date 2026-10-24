import Foundation

enum LaunchPurpose: String {
    case normal
    case diagnostic
}

struct LaunchConfiguration {
    let dataDirectory: URL
    let purpose: LaunchPurpose
}

enum LaunchDecision {
    case run(LaunchConfiguration)
    case help(String)
    case failure(String)
}

enum LaunchPolicy {
    static let markerName = ".easysink-diagnostic-data.json"
    static let usage = """
    Usage: WiseReader [--data-dir PATH]

      With no arguments, open the normal EasySink Candidate library.
      --data-dir PATH  Open a pre-marked isolated diagnostic library.
      --help, -h       Show this help without launching the application.
    """

    static func resolve(arguments: [String], homeDirectory: URL,
                        fileManager: FileManager = .default) -> LaunchDecision {
        guard !arguments.isEmpty else { return .failure("Missing executable argument.") }
        let values = Array(arguments.dropFirst())
        if values == ["--help"] || values == ["-h"] { return .help(usage + "\n") }
        if values.isEmpty {
            return .run(LaunchConfiguration(
                dataDirectory: protectedDirectories(homeDirectory: homeDirectory)[0],
                purpose: .normal))
        }
        guard values.count == 2, values[0] == "--data-dir" else {
            return .failure("Unknown or incomplete arguments.\n" + usage + "\n")
        }
        let requested = URL(fileURLWithPath: values[1], relativeTo: nil).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: requested.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return .failure("Diagnostic data directory must already exist.")
        }
        let canonical = requested.resolvingSymlinksInPath().standardizedFileURL
        for protected in protectedDirectories(homeDirectory: homeDirectory) {
            if contains(protected, canonical) {
                return .failure("Protected EasySink libraries cannot be used for diagnostics.")
            }
        }
        guard fileManager.isWritableFile(atPath: canonical.path) else {
            return .failure("Diagnostic data directory must be writable.")
        }
        let marker = canonical.appendingPathComponent(markerName, isDirectory: false)
        do {
            let values = try marker.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size <= 4096 else {
                return .failure("Diagnostic marker must be a small regular file, not a symlink.")
            }
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: marker))
            guard let payload = object as? [String: Any],
                  payload["schema"] as? Int == 1,
                  payload["role"] as? String == "diagnostic" else {
                return .failure("Diagnostic marker has the wrong schema or role.")
            }
        } catch {
            return .failure("Diagnostic marker is missing or invalid.")
        }
        return .run(LaunchConfiguration(dataDirectory: canonical, purpose: .diagnostic))
    }

    static func protectedDirectories(homeDirectory: URL) -> [URL] {
        let support = homeDirectory.appendingPathComponent("Library/Application Support", isDirectory: true)
        return ["EasySink Candidate", "EasySink Paragraph Preview Data 002"].map {
            support.appendingPathComponent($0, isDirectory: true)
                .resolvingSymlinksInPath().standardizedFileURL
        }
    }

    private static func contains(_ root: URL, _ candidate: URL) -> Bool {
        let parent = root.pathComponents
        let child = candidate.pathComponents
        return child.count >= parent.count && Array(child.prefix(parent.count)) == parent
    }
}
