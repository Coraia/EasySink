import Foundation

private func require(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() {
        FileHandle.standardError.write(Data(("FAIL: " + message + "\n").utf8))
        exit(1)
    }
}

private func snapshot(_ root: URL) -> [String: String] {
    guard let enumerator = FileManager.default.enumerator(at: root,
        includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]) else {
        return [:]
    }
    var result: [String: String] = [:]
    for case let url as URL in enumerator {
        let relative = String(url.path.dropFirst(root.path.count + 1))
        let values = try! url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])
        result[relative] = "\(values.isRegularFile == true):\(values.isDirectory == true):\(values.isSymbolicLink == true):\(values.fileSize ?? 0)"
    }
    return result
}

@main
struct LaunchPolicyTest {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("easysink-launch-policy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = "/tmp/WiseReader"

        let empty = snapshot(root)
        if case .help(let text) = LaunchPolicy.resolve(arguments: [executable, "--help"], homeDirectory: root) {
            require(text.contains("--data-dir"), "help must describe --data-dir")
        } else { require(false, "--help must exit through help decision") }
        require(snapshot(root) == empty, "help must not write")

        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--unknown"], homeDirectory: root) {
        } else { require(false, "unknown option must fail") }
        require(snapshot(root) == empty, "unknown option must not write")

        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir"], homeDirectory: root) {
        } else { require(false, "missing data-dir value must fail") }
        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir", "/tmp/a", "--data-dir", "/tmp/b"], homeDirectory: root) {
        } else { require(false, "duplicate data-dir options must fail") }

        if case .run(let normal) = LaunchPolicy.resolve(arguments: [executable], homeDirectory: root) {
            require(normal.purpose == .normal, "zero arguments must preserve normal launch")
            require(normal.dataDirectory.lastPathComponent == "EasySink Candidate", "normal target must be formal library")
        } else { require(false, "zero arguments must resolve normally") }
        require(snapshot(root) == empty, "normal resolution must not create the library")

        let support = root.appendingPathComponent("Library/Application Support", isDirectory: true)
        let formal = support.appendingPathComponent("EasySink Candidate", isDirectory: true)
        let preview = support.appendingPathComponent("EasySink Paragraph Preview Data 002", isDirectory: true)
        try FileManager.default.createDirectory(at: formal, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: preview, withIntermediateDirectories: true)
        for directory in [formal, preview] {
            let marker = directory.appendingPathComponent(LaunchPolicy.markerName)
            try Data("{\"schema\":1,\"role\":\"diagnostic\"}".utf8).write(to: marker)
            let before = snapshot(root)
            if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir", directory.path], homeDirectory: root) {
            } else { require(false, "protected directory must fail") }
            require(snapshot(root) == before, "protected rejection must not write")
        }

        let alias = root.appendingPathComponent("formal-alias", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: formal)
        let beforeAlias = snapshot(root)
        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir", alias.path], homeDirectory: root) {
        } else { require(false, "symlink to protected directory must fail") }
        require(snapshot(root) == beforeAlias, "symlink rejection must not write")

        let protectedChild = formal.appendingPathComponent("child", isDirectory: true)
        try FileManager.default.createDirectory(at: protectedChild, withIntermediateDirectories: true)
        try Data("{\"schema\":1,\"role\":\"diagnostic\"}".utf8)
            .write(to: protectedChild.appendingPathComponent(LaunchPolicy.markerName))
        let beforeChild = snapshot(root)
        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir", protectedChild.path], homeDirectory: root) {
        } else { require(false, "protected descendant must fail") }
        require(snapshot(root) == beforeChild, "protected descendant rejection must not write")

        let isolated = root.appendingPathComponent("isolated", isDirectory: true)
        try FileManager.default.createDirectory(at: isolated, withIntermediateDirectories: true)
        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir", isolated.path], homeDirectory: root) {
        } else { require(false, "missing marker must fail") }
        try Data("{\"schema\":1,\"role\":\"formal\"}".utf8)
            .write(to: isolated.appendingPathComponent(LaunchPolicy.markerName))
        if case .failure = LaunchPolicy.resolve(arguments: [executable, "--data-dir", isolated.path], homeDirectory: root) {
        } else { require(false, "wrong marker role must fail") }
        try Data("{\"schema\":1,\"role\":\"diagnostic\"}".utf8)
            .write(to: isolated.appendingPathComponent(LaunchPolicy.markerName))
        if case .run(let diagnostic) = LaunchPolicy.resolve(arguments: [executable, "--data-dir", isolated.path], homeDirectory: root) {
            require(diagnostic.purpose == .diagnostic, "marked isolated directory must be diagnostic")
            require(diagnostic.dataDirectory == isolated.resolvingSymlinksInPath(), "diagnostic path must be canonical")
        } else { require(false, "marked isolated directory must pass") }

        print("Swift launch policy checks passed")
    }
}
