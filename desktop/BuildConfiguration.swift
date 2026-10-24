import Foundation

enum DesktopBuildConfiguration {
    #if EASYSINK_DIAGNOSTIC
    static let profile = DesktopBuildProfile(
        flavor: .diagnostic,
        bundleIdentifier: "com.coraia.wisereader.diagnostic",
        productName: "EasySink Diagnostic",
        dataDirectoryName: "EasySink Diagnostic Data 001",
        rootID: "easysink-diagnostic-001")
    #elseif EASYSINK_PREVIEW
    static let profile = DesktopBuildProfile(
        flavor: .preview,
        bundleIdentifier: "com.coraia.wisereader.preview",
        productName: "EasySink Preview",
        dataDirectoryName: "EasySink Paragraph Preview Data 002",
        rootID: "easysink-preview-002")
    #else
    static let profile = DesktopBuildProfile(
        flavor: .production,
        bundleIdentifier: "com.coraia.wisereader.candidate",
        productName: "EasySink",
        dataDirectoryName: "EasySink Candidate",
        rootID: "easysink-formal-candidate")
    #endif
}
