import Darwin
import Foundation

enum DesktopBuildFlavor: String {
    case production
    case preview
    case diagnostic
}

struct DesktopBuildProfile: Equatable {
    let flavor: DesktopBuildFlavor
    let bundleIdentifier: String
    let productName: String
    let dataDirectoryName: String
    let rootID: String
}

struct LaunchConfiguration {
    let dataDirectory: URL
    let profile: DesktopBuildProfile
}

enum LaunchDecision {
    case run(LaunchConfiguration)
    case help(String)
    case failure(String)
}

enum LaunchPolicy {
    static let markerName = ".easysink-diagnostic-data.json"
    static let usage = "Usage: WiseReader [--help]"

    static func resolve(arguments: [String], homeDirectory: URL,
                        profile: DesktopBuildProfile,
                        actualBundleIdentifier: String?, declaredFlavor: String?,
                        fileManager: FileManager = .default) -> LaunchDecision {
        guard !arguments.isEmpty else { return .failure("Missing executable argument.") }
        let values = Array(arguments.dropFirst())
        if values == ["--help"] || values == ["-h"] { return .help(usage + "\n") }
        guard values.isEmpty else {
            return .failure("This build does not accept data-directory or flavor overrides.\n" + usage)
        }
        guard actualBundleIdentifier == profile.bundleIdentifier else {
            return .failure("The running bundle identity does not match its compiled build flavor.")
        }
        guard declaredFlavor == profile.flavor.rawValue else {
            return .failure("The packaged build flavor does not match the native executable.")
        }

        let directory = fixedDirectory(profile: profile, homeDirectory: homeDirectory)
        if profile.flavor != .diagnostic {
            return .run(LaunchConfiguration(dataDirectory: directory, profile: profile))
        }
        do {
            try validateDiagnosticDirectory(directory, profile: profile, homeDirectory: homeDirectory,
                                            fileManager: fileManager)
            return .run(LaunchConfiguration(dataDirectory: directory, profile: profile))
        } catch {
            return .failure("Diagnostic data root rejected: \(error.localizedDescription)")
        }
    }

    static func fixedDirectory(profile: DesktopBuildProfile, homeDirectory: URL) -> URL {
        let home = homeDirectory.resolvingSymlinksInPath().standardizedFileURL
        return home.appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(profile.dataDirectoryName, isDirectory: true).standardizedFileURL
    }

    static func protectedDirectories(homeDirectory: URL) -> [URL] {
        let home = homeDirectory.resolvingSymlinksInPath().standardizedFileURL
        let support = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        return ["EasySink Candidate", "EasySink Paragraph Preview Data 002"].map {
            support.appendingPathComponent($0, isDirectory: true)
                .resolvingSymlinksInPath().standardizedFileURL
        }
    }

    private static func validateDiagnosticDirectory(_ directory: URL, profile: DesktopBuildProfile,
                                                     homeDirectory: URL, fileManager: FileManager) throws {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw PolicyError("the fixed root does not already exist")
        }
        let rootValues = try directory.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw PolicyError("the fixed root must be a real directory, not a symlink")
        }
        let canonical = directory.resolvingSymlinksInPath().standardizedFileURL
        guard canonical == directory.standardizedFileURL else {
            throw PolicyError("the fixed root contains a symlink")
        }
        guard !protectedDirectories(homeDirectory: homeDirectory).contains(where: { contains($0, canonical) }) else {
            throw PolicyError("a protected reading library cannot be a diagnostic root")
        }
        try validateOwnerAndMode(canonical, fileManager: fileManager, kind: "diagnostic root")

        let marker = canonical.appendingPathComponent(markerName, isDirectory: false)
        let markerValues = try marker.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard markerValues.isRegularFile == true, markerValues.isSymbolicLink != true,
              let size = markerValues.fileSize, size <= 4096 else {
            throw PolicyError("the marker must be a small regular file, not a symlink")
        }
        try validateOwnerAndMode(marker, fileManager: fileManager, kind: "diagnostic marker")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: marker))
        guard let payload = object as? [String: Any], payload["schema"] as? Int == 2,
              payload["role"] as? String == "diagnostic",
              payload["root_id"] as? String == profile.rootID,
              payload["bundle_id"] as? String == profile.bundleIdentifier else {
            throw PolicyError("the marker identity does not match this diagnostic build")
        }
    }

    private static func validateOwnerAndMode(_ url: URL, fileManager: FileManager, kind: String) throws {
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        guard let owner = attributes[.ownerAccountID] as? NSNumber,
              owner.uint32Value == Darwin.getuid() else {
            throw PolicyError("the \(kind) must be owned by the current user")
        }
        guard let mode = attributes[.posixPermissions] as? NSNumber,
              mode.intValue & 0o077 == 0 else {
            throw PolicyError("the \(kind) must not be accessible by group or other users")
        }
    }

    private static func contains(_ root: URL, _ candidate: URL) -> Bool {
        let parent = root.pathComponents
        let child = candidate.pathComponents
        return child.count >= parent.count && Array(child.prefix(parent.count)) == parent
    }

    private struct PolicyError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
