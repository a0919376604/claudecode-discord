// swift-tools-version:5.9
import PackageDescription

// Uses swift-testing external package for the test framework. Swift 6+
// bundles Testing natively but the test target's module resolution still
// requires the explicit dependency in swift-tools-version 5.9 manifests.
// Safe to migrate to bundled Testing when we bump swift-tools-version to 6.0.
let package = Package(
    name: "ClaudeBotMenu",
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-testing.git", from: "0.10.0"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudeBotMenu",
            path: ".",
            exclude: ["Package.swift", "Tests", "TESTING-updater.md", "ClaudeBotMenu"],
            sources: ["ClaudeBotMenu.swift", "ClaudeUpdater.swift"]
        ),
        .testTarget(
            name: "ClaudeUpdaterTests",
            dependencies: [
                "ClaudeBotMenu",
                .product(name: "Testing", package: "swift-testing"),
            ],
            path: "Tests",
            sources: ["ClaudeUpdaterTests.swift"]
        )
    ]
)
