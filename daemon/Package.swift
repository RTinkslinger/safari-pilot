// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SafariPilotd",
    // Core daemon (stdin NDJSON, TCP:19474, AppleScript) works on macOS 12+.
    // ExtensionHTTPServer (Hummingbird, HTTP:19475) requires macOS 14+ — guarded
    // at runtime with @available(macOS 14.0, *) in main.swift.
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
    ],
    targets: [
        .target(
            name: "SafariPilotdCore",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            path: "Sources/SafariPilotdCore"
        ),
        .executableTarget(
            name: "SafariPilotd",
            dependencies: ["SafariPilotdCore"],
            path: "Sources/SafariPilotd"
        ),
        .executableTarget(
            name: "SafariPilotdTests",
            dependencies: ["SafariPilotdCore"],
            path: "Tests/SafariPilotdTests"
        ),
    ]
)
