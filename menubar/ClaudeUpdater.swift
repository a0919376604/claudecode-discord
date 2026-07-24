import Foundation

/// Pure logic + Codable types for the tray's Claude auto-updater.
/// Kept side-effect-free so all functions can be unit-tested.
enum ClaudeUpdater {

    // MARK: - Types

    enum Kind: String, Codable {
        case cli
        case sdk
    }

    struct BlocklistEntry: Codable, Equatable {
        var version: String
        var attempts: Int
        var lastFailedAt: Date
        var reason: String
        var logSnippet: String?

        enum CodingKeys: String, CodingKey {
            case version
            case attempts
            case lastFailedAt = "last_failed_at"
            case reason
            case logSnippet = "log_snippet"
        }
    }

    struct HistoryEntry: Codable, Equatable {
        var kind: Kind
        var from: String?
        var to: String
        var at: Date
        var outcome: String   // "success" | "failed" | "rollback_failed"
        var failedAtStep: String?

        enum CodingKeys: String, CodingKey {
            case kind
            case from
            case to
            case at
            case outcome
            case failedAtStep = "failed_at_step"
        }
    }

    struct CheckError: Codable {
        var at: Date
        var kind: Kind
        var reason: String
    }

    struct PackageState: Codable {
        var current: String?
        var blocklist: [BlocklistEntry]

        static let empty = PackageState(current: nil, blocklist: [])
    }

    struct State: Codable {
        var schemaVersion: Int
        var lastCheck: Date?
        var verifyRunTests: Bool
        var cli: PackageState
        var sdk: PackageState
        var history: [HistoryEntry]
        var checkErrors: [CheckError]

        enum CodingKeys: String, CodingKey {
            case schemaVersion = "schema_version"
            case lastCheck = "last_check"
            case verifyRunTests = "verify_run_tests"
            case cli
            case sdk
            case history
            case checkErrors = "check_errors"
        }
    }

    static let currentSchemaVersion = 1

    // MARK: - Defaults

    static func defaultState() -> State {
        State(
            schemaVersion: currentSchemaVersion,
            lastCheck: nil,
            verifyRunTests: true,
            cli: .empty,
            sdk: .empty,
            history: [],
            checkErrors: []
        )
    }

    // MARK: - Codable helpers

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func makeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = isoFormatter.date(from: s) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: c, debugDescription: "invalid ISO 8601 date: \(s)")
        }
        return d
    }

    private static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(isoFormatter.string(from: date))
        }
        return e
    }

    /// Decode a State from JSON. On corrupt input or schema mismatch,
    /// returns the default state instead of throwing.
    static func loadState(from data: Data) -> State {
        do {
            let s = try makeDecoder().decode(State.self, from: data)
            if s.schemaVersion != currentSchemaVersion {
                return defaultState()
            }
            return s
        } catch {
            return defaultState()
        }
    }

    static func serializeState(_ state: State) -> Data {
        do {
            return try makeEncoder().encode(state)
        } catch {
            // Shouldn't happen with our types — fall back to empty JSON object
            return "{}".data(using: .utf8)!
        }
    }

    // MARK: - Parse claude --version output

    /// Extract semver from "X.Y.Z (Claude Code)" output. Returns nil if not
    /// a valid X.Y.Z prefix.
    static func parseClaudeVersion(_ output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let firstToken = trimmed.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
        let comps = firstToken.split(separator: ".")
        guard comps.count >= 2 else { return nil }
        guard comps.allSatisfy({ Int($0) != nil }) else { return nil }
        return firstToken
    }

    // MARK: - Semver comparison

    /// Compare two dotted numeric version strings (e.g. "0.2.141" < "0.3.0").
    /// Missing components treated as 0. Non-numeric components are treated
    /// as 0 (prerelease tags fall back to numeric prefix comparison).
    static func compareSemver(_ a: String, _ b: String) -> ComparisonResult {
        let aParts = a.split(separator: ".").map { Int($0) ?? 0 }
        let bParts = b.split(separator: ".").map { Int($0) ?? 0 }
        let len = Swift.max(aParts.count, bParts.count)
        for i in 0..<len {
            let av = i < aParts.count ? aParts[i] : 0
            let bv = i < bParts.count ? bParts[i] : 0
            if av < bv { return .orderedAscending }
            if av > bv { return .orderedDescending }
        }
        return .orderedSame
    }

    // MARK: - Blocklist logic

    /// Version is blocklisted once its attempts reach the threshold (3).
    /// Entries with attempts < 3 are "in-progress failures," not yet blocking.
    static let blocklistThreshold = 3

    static func isBlocklisted(_ version: String, blocklist: [BlocklistEntry]) -> Bool {
        guard let entry = blocklist.first(where: { $0.version == version }) else {
            return false
        }
        return entry.attempts >= blocklistThreshold
    }

    /// Add a new failed-attempt entry, or increment the count for an existing one.
    /// Caps the blocklist at 30 entries (drops least-recently-failed).
    static func upsertBlocklist(
        _ blocklist: [BlocklistEntry],
        version: String,
        reason: String,
        logSnippet: String?,
        now: Date
    ) -> [BlocklistEntry] {
        var result = blocklist
        if let idx = result.firstIndex(where: { $0.version == version }) {
            result[idx].attempts += 1
            result[idx].lastFailedAt = now
            result[idx].reason = reason
            result[idx].logSnippet = logSnippet
        } else {
            result.append(BlocklistEntry(
                version: version, attempts: 1,
                lastFailedAt: now, reason: reason, logSnippet: logSnippet
            ))
        }
        if result.count > 30 {
            result.sort { $0.lastFailedAt > $1.lastFailedAt }
            result = Array(result.prefix(30))
        }
        return result
    }

    // MARK: - Debounce

    /// Should the daily check run now, given the last-check timestamp?
    static func shouldCheck(lastCheck: Date?, now: Date, debounceHours: Int) -> Bool {
        guard let last = lastCheck else { return true }
        let debounceSeconds = TimeInterval(debounceHours * 3600)
        return now.timeIntervalSince(last) >= debounceSeconds
    }

    // MARK: - History rotation

    /// Append `newEntry`, then trim to at most `cap` entries (drop from the front).
    static func nextRotatedHistory(
        _ history: [HistoryEntry],
        newEntry: HistoryEntry,
        cap: Int
    ) -> [HistoryEntry] {
        var result = history
        result.append(newEntry)
        if result.count > cap {
            result = Array(result.suffix(cap))
        }
        return result
    }
}
