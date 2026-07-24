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
}
