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

// MARK: - parseClaudeVersion

@Test func parseClaudeVersionValid() {
    #expect(ClaudeUpdater.parseClaudeVersion("2.1.191 (Claude Code)\n") == "2.1.191")
}

@Test func parseClaudeVersionValidNoNewline() {
    #expect(ClaudeUpdater.parseClaudeVersion("2.1.191 (Claude Code)") == "2.1.191")
}

@Test func parseClaudeVersionEmpty() {
    #expect(ClaudeUpdater.parseClaudeVersion("") == nil)
}

@Test func parseClaudeVersionGarbage() {
    #expect(ClaudeUpdater.parseClaudeVersion("claude: command not found") == nil)
    #expect(ClaudeUpdater.parseClaudeVersion("error") == nil)
}

@Test func parseClaudeVersionOnlyMajor() {
    // "2 (Claude)" — only major, not enough
    #expect(ClaudeUpdater.parseClaudeVersion("2 (Claude Code)") == nil)
}

// MARK: - compareSemver

@Test func compareSemverLess() {
    #expect(ClaudeUpdater.compareSemver("0.2.141", "0.2.999") == .orderedAscending)
}

@Test func compareSemverGreater() {
    #expect(ClaudeUpdater.compareSemver("0.3.0", "0.2.999") == .orderedDescending)
}

@Test func compareSemverEqual() {
    #expect(ClaudeUpdater.compareSemver("1.0.0", "1.0.0") == .orderedSame)
}

@Test func compareSemverMajorJump() {
    #expect(ClaudeUpdater.compareSemver("0.2.141", "0.3.0") == .orderedAscending)
}

@Test func compareSemverMissingComponents() {
    // "1.0" == "1.0.0" (missing patch treated as 0)
    #expect(ClaudeUpdater.compareSemver("1.0", "1.0.0") == .orderedSame)
    #expect(ClaudeUpdater.compareSemver("1.0", "1.0.1") == .orderedAscending)
}

// MARK: - isBlocklisted

@Test func isBlocklistedIn() {
    let bl = [
        ClaudeUpdater.BlocklistEntry(
            version: "0.3.212", attempts: 3,
            lastFailedAt: Date(), reason: "x", logSnippet: nil
        )
    ]
    #expect(ClaudeUpdater.isBlocklisted("0.3.212", blocklist: bl))
}

@Test func isBlocklistedOut() {
    let bl = [
        ClaudeUpdater.BlocklistEntry(
            version: "0.3.212", attempts: 3,
            lastFailedAt: Date(), reason: "x", logSnippet: nil
        )
    ]
    #expect(!ClaudeUpdater.isBlocklisted("0.3.213", blocklist: bl))
    #expect(!ClaudeUpdater.isBlocklisted("0.3.212", blocklist: []))
}

@Test func isBlocklistedNotYetAtThreshold() {
    // attempts < 3 → not yet blocked
    let bl = [
        ClaudeUpdater.BlocklistEntry(
            version: "0.3.212", attempts: 2,
            lastFailedAt: Date(), reason: "x", logSnippet: nil
        )
    ]
    #expect(!ClaudeUpdater.isBlocklisted("0.3.212", blocklist: bl))
}

// MARK: - shouldCheck

@Test func shouldCheckNoLastCheck() {
    #expect(ClaudeUpdater.shouldCheck(lastCheck: nil, now: Date(), debounceHours: 20))
}

@Test func shouldCheckRecent() {
    let now = Date()
    let fiveHoursAgo = now.addingTimeInterval(-5 * 3600)
    #expect(!ClaudeUpdater.shouldCheck(lastCheck: fiveHoursAgo, now: now, debounceHours: 20))
}

@Test func shouldCheckOld() {
    let now = Date()
    let twentyFiveHoursAgo = now.addingTimeInterval(-25 * 3600)
    #expect(ClaudeUpdater.shouldCheck(lastCheck: twentyFiveHoursAgo, now: now, debounceHours: 20))
}

// MARK: - nextRotatedHistory

@Test func nextRotatedHistoryUnderCap() {
    var history: [ClaudeUpdater.HistoryEntry] = []
    for i in 0..<20 {
        history.append(ClaudeUpdater.HistoryEntry(
            kind: .cli, from: "v\(i-1)", to: "v\(i)",
            at: Date(), outcome: "success", failedAtStep: nil))
    }
    let newEntry = ClaudeUpdater.HistoryEntry(
        kind: .cli, from: "v19", to: "v20",
        at: Date(), outcome: "success", failedAtStep: nil)
    let result = ClaudeUpdater.nextRotatedHistory(history, newEntry: newEntry, cap: 30)
    #expect(result.count == 21)
    #expect(result.last?.to == "v20")
}

@Test func nextRotatedHistoryOverCap() {
    var history: [ClaudeUpdater.HistoryEntry] = []
    for i in 0..<30 {
        history.append(ClaudeUpdater.HistoryEntry(
            kind: .cli, from: "v\(i-1)", to: "v\(i)",
            at: Date(), outcome: "success", failedAtStep: nil))
    }
    let newEntry = ClaudeUpdater.HistoryEntry(
        kind: .cli, from: "v29", to: "v30",
        at: Date(), outcome: "success", failedAtStep: nil)
    let result = ClaudeUpdater.nextRotatedHistory(history, newEntry: newEntry, cap: 30)
    #expect(result.count == 30)
    #expect(result.first?.to == "v1", "oldest (v0) should be dropped")
    #expect(result.last?.to == "v30")
}

// MARK: - upsertBlocklist

@Test func upsertBlocklistNewEntry() {
    let now = Date()
    let result = ClaudeUpdater.upsertBlocklist(
        [], version: "0.3.212", reason: "verify failed",
        logSnippet: "err TS2322", now: now)
    #expect(result.count == 1)
    #expect(result[0].version == "0.3.212")
    #expect(result[0].attempts == 1)
    #expect(result[0].reason == "verify failed")
}

@Test func upsertBlocklistIncrementsExisting() {
    let now = Date()
    let earlier = now.addingTimeInterval(-3600)
    let existing = [ClaudeUpdater.BlocklistEntry(
        version: "0.3.212", attempts: 1,
        lastFailedAt: earlier, reason: "old reason", logSnippet: nil)]
    let result = ClaudeUpdater.upsertBlocklist(
        existing, version: "0.3.212", reason: "new reason",
        logSnippet: "new snippet", now: now)
    #expect(result.count == 1)
    #expect(result[0].attempts == 2)
    #expect(result[0].reason == "new reason")
    #expect(result[0].logSnippet == "new snippet")
    #expect(result[0].lastFailedAt == now)
}
