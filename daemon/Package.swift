// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SafariPilotd",
    platforms: [.macOS(.v12)],
    targets: [
        .target(
            name: "SafariPilotdCore",
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
