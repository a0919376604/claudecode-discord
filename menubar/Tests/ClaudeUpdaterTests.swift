import Testing
import Foundation
@testable import ClaudeBotMenu

// MARK: - State I/O

@Test func defaultStateHasSchemaVersion1() {
    let s = ClaudeUpdater.defaultState()
    #expect(s.schemaVersion == 1)
    #expect(s.lastCheck == nil)
    #expect(s.verifyRunTests == true)
    #expect(s.cli.current == nil)
    #expect(s.cli.blocklist.isEmpty)
    #expect(s.sdk.current == nil)
    #expect(s.sdk.blocklist.isEmpty)
    #expect(s.history.isEmpty)
    #expect(s.checkErrors.isEmpty)
}

@Test func loadStateValidV1() {
    let json = """
    {
      "schema_version": 1,
      "last_check": "2026-07-13T08:42:04Z",
      "verify_run_tests": true,
      "cli": {"current": "2.1.191", "blocklist": []},
      "sdk": {"current": "0.2.141", "blocklist": []},
      "history": [],
      "check_errors": []
    }
    """.data(using: .utf8)!
    let s = ClaudeUpdater.loadState(from: json)
    #expect(s.schemaVersion == 1)
    #expect(s.cli.current == "2.1.191")
    #expect(s.sdk.current == "0.2.141")
    #expect(s.lastCheck != nil)
}

@Test func loadStateCorruptReturnsDefault() {
    let bad = "not valid json {{{{".data(using: .utf8)!
    let s = ClaudeUpdater.loadState(from: bad)
    #expect(s.schemaVersion == 1)
    #expect(s.cli.current == nil)
}

@Test func loadStateSchemaMismatchReturnsDefault() {
    // schema_version 99 → decoder either fails or we bail on version check
    let json = """
    {
      "schema_version": 99,
      "verify_run_tests": true,
      "cli": {"current": null, "blocklist": []},
      "sdk": {"current": null, "blocklist": []},
      "history": [],
      "check_errors": []
    }
    """.data(using: .utf8)!
    let s = ClaudeUpdater.loadState(from: json)
    #expect(s.schemaVersion == 1, "schema mismatch should fall back to defaults")
    #expect(s.cli.current == nil)
}

@Test func serializeStateRoundtrip() {
    var s = ClaudeUpdater.defaultState()
    s.lastCheck = Date(timeIntervalSince1970: 1_700_000_000)
    s.cli.current = "2.1.191"
    s.sdk.current = "0.2.141"
    s.history.append(ClaudeUpdater.HistoryEntry(
        kind: .cli, from: "2.1.190", to: "2.1.191",
        at: Date(timeIntervalSince1970: 1_700_000_000),
        outcome: "success", failedAtStep: nil
    ))
    let data = ClaudeUpdater.serializeState(s)
    let decoded = ClaudeUpdater.loadState(from: data)
    #expect(decoded.cli.current == "2.1.191")
    #expect(decoded.sdk.current == "0.2.141")
    #expect(decoded.history.count == 1)
    #expect(decoded.history[0].kind == .cli)
    #expect(decoded.history[0].to == "2.1.191")
}

@Test func serializeUsesISO8601Dates() {
    var s = ClaudeUpdater.defaultState()
    s.lastCheck = Date(timeIntervalSince1970: 1_700_000_000)  // 2023-11-14T22:13:20Z
    let data = ClaudeUpdater.serializeState(s)
    let str = String(data: data, encoding: .utf8)!
    #expect(str.contains("2023-11-14T22:13:20Z"),
            "Expected ISO 8601 date; got: \(str)")
}
