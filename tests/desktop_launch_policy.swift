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

private func decide(_ arguments: [String], home: URL, profile: DesktopBuildProfile,
                    bundle: String? = nil, flavor: String? = nil) -> LaunchDecision {
    LaunchPolicy.resolve(arguments: arguments, homeDirectory: home, profile: profile,
        actualBundleIdentifier: bundle ?? profile.bundleIdentifier,
        declaredFlavor: flavor ?? profile.flavor.rawValue)
}

private func secureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
}

private func mark(_ directory: URL, profile: DesktopBuildProfile,
                  schema: Int = 2, role: String = "diagnostic") throws {
    let marker = directory.appendingPathComponent(LaunchPolicy.markerName)
    let payload: [String: Any] = [
        "schema": schema, "role": role,
        "root_id": profile.rootID, "bundle_id": profile.bundleIdentifier,
    ]
    try JSONSerialization.data(withJSONObject: payload).write(to: marker)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
}

@main
struct LaunchPolicyTest {
    static func main() throws {
        #if EASYSINK_DIAGNOSTIC
        require(DesktopBuildConfiguration.profile.flavor == .diagnostic,
                "diagnostic compile flag must select the diagnostic profile")
        require(DesktopBuildConfiguration.profile.bundleIdentifier == "com.coraia.wisereader.diagnostic" &&
                DesktopBuildConfiguration.profile.dataDirectoryName == "EasySink Diagnostic Data 001" &&
                DesktopBuildConfiguration.profile.rootID == "easysink-diagnostic-001",
                "diagnostic compile identity must stay fixed")
        #elseif EASYSINK_PREVIEW
        require(DesktopBuildConfiguration.profile.flavor == .preview,
                "Preview compile flag must select the Preview profile")
        require(DesktopBuildConfiguration.profile.bundleIdentifier == "com.coraia.wisereader.preview" &&
                DesktopBuildConfiguration.profile.dataDirectoryName == "EasySink Paragraph Preview Data 002" &&
                DesktopBuildConfiguration.profile.rootID == "easysink-preview-002",
                "Preview compile identity must stay fixed")
        #else
        require(DesktopBuildConfiguration.profile.flavor == .production,
                "default compile must select the production profile")
        require(DesktopBuildConfiguration.profile.bundleIdentifier == "com.coraia.wisereader.candidate" &&
                DesktopBuildConfiguration.profile.dataDirectoryName == "EasySink Candidate" &&
                DesktopBuildConfiguration.profile.rootID == "easysink-formal-candidate",
                "production compile identity must stay fixed")
        #endif
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("easysink-launch-policy-\(UUID().uuidString)", isDirectory: true)
        try secureDirectory(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = "/tmp/WiseReader"
        let production = DesktopBuildProfile(flavor: .production,
            bundleIdentifier: "com.coraia.wisereader.candidate", productName: "EasySink",
            dataDirectoryName: "EasySink Candidate", rootID: "easysink-formal-candidate")
        let preview = DesktopBuildProfile(flavor: .preview,
            bundleIdentifier: "com.coraia.wisereader.preview", productName: "EasySink Preview",
            dataDirectoryName: "EasySink Paragraph Preview Data 002", rootID: "easysink-preview-002")
        let diagnostic = DesktopBuildProfile(flavor: .diagnostic,
            bundleIdentifier: "com.coraia.wisereader.diagnostic", productName: "EasySink Diagnostic",
            dataDirectoryName: "EasySink Diagnostic Data 001", rootID: "easysink-diagnostic-001")

        let empty = snapshot(root)
        if case .help(let text) = decide([executable, "--help"], home: root, profile: production) {
            require(text.contains("--help"), "help must describe the only accepted option")
        } else { require(false, "--help must exit through help decision") }
        require(snapshot(root) == empty, "help must not write")
        for arguments in [[executable, "--unknown"], [executable, "--data-dir", "/tmp/a"],
                          [executable, "--launch-flavor", "diagnostic"]] {
            if case .failure = decide(arguments, home: root, profile: production) {
            } else { require(false, "override arguments must fail") }
        }
        require(snapshot(root) == empty, "argument rejection must not write")

        if case .run(let normal) = decide([executable], home: root, profile: production) {
            require(normal.profile.flavor == .production, "production flavor must be retained")
            require(normal.dataDirectory.lastPathComponent == "EasySink Candidate", "production root must be fixed")
        } else { require(false, "production no-argument launch must resolve normally") }
        if case .run(let value) = decide([executable], home: root, profile: preview) {
            require(value.dataDirectory.lastPathComponent == "EasySink Paragraph Preview Data 002",
                    "Preview root must be fixed")
        } else { require(false, "Preview no-argument launch must resolve normally") }
        if case .failure = decide([executable], home: root, profile: production,
                                  bundle: diagnostic.bundleIdentifier) {
        } else { require(false, "bundle mismatch must fail") }
        if case .failure = decide([executable], home: root, profile: production, flavor: "diagnostic") {
        } else { require(false, "declared flavor mismatch must fail") }
        require(snapshot(root) == empty, "fixed production/Preview resolution must not create a library")

        let formal = LaunchPolicy.fixedDirectory(profile: production, homeDirectory: root)
        let previewRoot = LaunchPolicy.fixedDirectory(profile: preview, homeDirectory: root)
        try secureDirectory(formal)
        try secureDirectory(previewRoot)
        let protectedBefore = [snapshot(formal), snapshot(previewRoot)]

        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "missing fixed diagnostic root must fail") }
        let isolated = LaunchPolicy.fixedDirectory(profile: diagnostic, homeDirectory: root)
        try secureDirectory(isolated)
        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "missing marker must fail") }
        let externalMarker = root.appendingPathComponent("external-marker.json")
        try Data("{}".utf8).write(to: externalMarker)
        try FileManager.default.createSymbolicLink(
            at: isolated.appendingPathComponent(LaunchPolicy.markerName), withDestinationURL: externalMarker)
        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "marker symlink must fail") }
        try FileManager.default.removeItem(at: isolated.appendingPathComponent(LaunchPolicy.markerName))
        try mark(isolated, profile: diagnostic, schema: 1)
        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "old marker schema must fail") }
        try mark(isolated, profile: diagnostic, role: "formal")
        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "wrong marker role must fail") }
        try mark(isolated, profile: diagnostic)
        try FileManager.default.setAttributes([.posixPermissions: 0o644],
                                              ofItemAtPath: isolated.appendingPathComponent(LaunchPolicy.markerName).path)
        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "insecure marker mode must fail") }
        try mark(isolated, profile: diagnostic)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: isolated.path)
        if case .failure = decide([executable], home: root, profile: diagnostic) {
        } else { require(false, "insecure root mode must fail") }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: isolated.path)

        let firstDecision = decide([executable], home: root, profile: diagnostic)
        let secondDecision = decide([executable], home: root, profile: diagnostic)
        guard case .run(let first) = firstDecision, case .run(let second) = secondDecision else {
            require(false, "direct and LaunchServices-equivalent no-argument diagnostic launches must resolve")
            return
        }
        require(first.dataDirectory == isolated && second.dataDirectory == isolated,
                "argument stripping and repeat launch must stay pinned to the diagnostic root")
        let firstLock = try NativeInstanceLock.acquire(directory: isolated)
        do {
            _ = try NativeInstanceLock.acquire(directory: isolated)
            require(false, "duplicate instance lock must fail")
        } catch NativeInstanceLockError.alreadyRunning {
        }
        withExtendedLifetime(firstLock) {}
        let insecureLockRoot = root.appendingPathComponent("insecure-lock", isDirectory: true)
        try secureDirectory(insecureLockRoot)
        let insecureLock = insecureLockRoot.appendingPathComponent("desktop-native.lock")
        try Data().write(to: insecureLock)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: insecureLock.path)
        do {
            _ = try NativeInstanceLock.acquire(directory: insecureLockRoot)
            require(false, "insecure pre-existing native lock must fail")
        } catch NativeInstanceLockError.unavailable {
        }

        let malicious = DesktopBuildProfile(flavor: .diagnostic,
            bundleIdentifier: diagnostic.bundleIdentifier, productName: diagnostic.productName,
            dataDirectoryName: production.dataDirectoryName, rootID: diagnostic.rootID)
        if case .failure = decide([executable], home: root, profile: malicious) {
        } else { require(false, "diagnostic flavor must never use a protected root") }

        let aliasHome = root.appendingPathComponent("alias-home", isDirectory: true)
        let aliasSupport = aliasHome.appendingPathComponent("Library/Application Support", isDirectory: true)
        try secureDirectory(aliasSupport)
        let target = root.appendingPathComponent("symlink-target", isDirectory: true)
        try secureDirectory(target)
        try mark(target, profile: diagnostic)
        let alias = aliasSupport.appendingPathComponent(diagnostic.dataDirectoryName, isDirectory: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: target)
        if case .failure = decide([executable], home: aliasHome, profile: diagnostic) {
        } else { require(false, "fixed-root symlink must fail") }

        require(snapshot(formal) == protectedBefore[0], "fake Formal must remain byte/metadata-shape unchanged")
        require(snapshot(previewRoot) == protectedBefore[1], "fake Preview must remain unchanged")
        print("Swift fixed-root launch policy checks passed")
    }
}
