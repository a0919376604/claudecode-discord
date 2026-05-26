# OAuth Token Auto-Refresh — VS Code-Style Background Refresh

Date: 2026-05-26
Status: Draft (pending user review)
Branch: TBD (to be created during plan execution)
Scope: macOS only for v1

## Summary

The Discord bot will silently refresh the user's Claude Code OAuth
access token before it expires, eliminating the recurring "please run
`claude login`" interruption that today fires roughly every 8 hours.

Implementation reads the OAuth credentials from the macOS Keychain
(`Claude Code-credentials`), checks `expiresAt`, and — if the access
token is within 30 minutes of expiry — POSTs to Anthropic's official
OAuth refresh endpoint with the stored refresh token. The new tokens
are written back to the Keychain in the same JSON shape the Claude CLI
uses, so the next `claude` subprocess spawned by the Agent SDK picks
them up transparently.

This is the same OAuth refresh dance VS Code's Claude Code extension
performs in the background. We are not inventing a new auth mechanism —
we are calling the same endpoint the official client calls.

## Motivation

Today the bot runs 24/7 but each `query()` call spawns a fresh `claude`
subprocess that reads credentials from the Keychain at startup. If the
access token has expired and the user has not been interactively
running the CLI to trigger its built-in refresh, the subprocess
returns an auth error. The bot detects this via keyword matching in
`session-manager.ts` and surfaces a Discord message telling the user
to run `claude login`.

The user reports having to do this roughly every 4-8 hours. This
contradicts the experience inside VS Code, where the same OAuth
account stays logged in indefinitely — because the long-running VS
Code extension proactively refreshes the token in the background.

The Discord bot is also a long-running process. It has all the
information needed (refreshToken in Keychain, expiresAt timestamp,
the same OAuth endpoint that VS Code hits) to do exactly the same
thing. There is no reason to keep waking the user up to do manually
what the bot can do automatically.

This is also a direct application of the CLAUDE.md principle 수동
조치 금지 ("no manual user steps"): if the code can solve it, the user
should not be asked to.

## Relationship to existing features

- **Discord re-login notification** (`session-manager.ts` lines
  515-521, 593-600): The existing keyword-based detection of auth
  errors stays in place untouched. It becomes the fallback for the
  rare case where the refresh token itself has expired or been
  revoked. With this change in place we expect that path to fire
  approximately never in normal use, but it remains the safety net.

- **`ANTHROPIC_API_KEY` unset** (`session-manager.ts` line 229): The
  existing code deliberately strips `ANTHROPIC_API_KEY` from the
  subprocess env so the CLI uses OAuth subscription billing rather
  than pay-per-token API billing. This must stay. Our refresh path
  also uses OAuth, so we preserve that intent.

- **`claude setup-token`**: Anthropic's official path for long-lived
  tokens. We deliberately do NOT use it for v1 because it requires
  the user to run an extra setup command. The OAuth refresh path is
  more transparent and uses credentials the user has already
  provided.

## Non-goals

- **Linux and Windows support.** Out of scope for v1. The credentials
  refresher will detect non-darwin platforms and silently no-op, so
  Linux and Windows users continue with today's behavior (manual
  re-login when prompted via Discord). Adding them is straightforward
  follow-up work (Linux: read/write `~/.claude/.credentials.json`;
  Windows: Credential Manager via PowerShell or a native module).

- **Mid-query refresh.** If the access token expires while a `query()`
  is mid-flight, we do not preemptively refresh during the call. The
  subprocess will either complete on the still-valid-at-spawn token
  or fail with an auth error that the existing path handles. Adding
  mid-query refresh requires changes to the subprocess auth handshake
  and is not justified by current usage patterns.

- **Background timer / periodic refresh.** Approach B and C from
  brainstorming. We start with lazy-only because refresh tokens
  typically last 30+ days and any user interactive enough to be
  affected by 8-hour access-token expiry will trigger lazy refresh
  well within the refresh-token lifetime. If real-world usage shows
  refresh tokens dying during idle periods, add a periodic safety
  net later.

- **Multi-bot / multi-PC coordination.** If multiple bot processes
  share the same Keychain entry (e.g., bot running while user also
  uses Claude CLI interactively), both will read and potentially
  refresh the same credentials. OAuth refresh-token rotation can
  invalidate one party's stored refresh_token. v1 does not coordinate
  between processes — last writer wins, and a losing party will fall
  back to the Discord re-login prompt. This is acceptable because
  the Keychain is typically accessed only by one Claude tool at a
  time on a given machine.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ src/claude/credentials-refresher.ts            (NEW FILE)  │
│                                                            │
│  ensureFreshCredentials()  ◄── main entry, idempotent      │
│    │                                                       │
│    ├─ readKeychain()                                       │
│    │    └─ exec: security find-generic-password ...        │
│    │                                                       │
│    ├─ needsRefresh(creds)                                  │
│    │    └─ creds.expiresAt - Date.now() <                  │
│    │       REFRESH_THRESHOLD_MS                            │
│    │                                                       │
│    ├─ callRefreshEndpoint(refreshToken)                    │
│    │    └─ POST platform.claude.com/v1/oauth/token         │
│    │                                                       │
│    └─ writeKeychain(newCreds)                              │
│         └─ exec: security add-generic-password -U ...      │
└────────────────────────────────────────────────────────────┘
              ▲                          ▲
              │                          │
   src/claude/session-manager.ts   src/index.ts
   sendMessage() top of fn         on bot startup
   await ensureFreshCredentials()  fire-and-forget
```

### Public API of the new module

```ts
// src/claude/credentials-refresher.ts

/**
 * Ensure Keychain holds a non-expired access token before the caller
 * spawns a claude subprocess. Idempotent: cheap when token is fresh
 * (no HTTP), self-deduplicating when called concurrently.
 *
 * Never throws. Logs and returns on failure — the caller proceeds
 * with whatever credentials the Keychain currently holds and the
 * existing auth-error path in session-manager surfaces any problem
 * to the user.
 */
export async function ensureFreshCredentials(): Promise<void>;
```

The function returns `Promise<void>`, not a status, by design: callers
must not branch on its outcome. The contract is "best-effort refresh,
never block the user." If the refresh failed, the next `query()`
behaves exactly as it does today.

### Internal types

```ts
interface KeychainCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;          // ms epoch
  scopes: string[];
  subscriptionType: string;   // preserved across refreshes
  rateLimitTier?: string;     // preserved if present
}
```

### Refresh endpoint contract

Request:
```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
User-Agent: claudecode-discord/<package.json version>

{
  "grant_type": "refresh_token",
  "refresh_token": "<current refreshToken from Keychain>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

The `client_id` value is the Claude Code CLI's OAuth client ID,
extracted from the bundled `@anthropic-ai/claude-agent-sdk` source.
Using it identifies our refresh request as coming from the Claude
Code family of clients, which matches the scopes already granted to
the stored refresh token.

Expected response (standard OAuth 2.0 token response):
```json
{
  "access_token": "sk-ant-oat01-...",
  "refresh_token": "sk-ant-ort01-...",
  "expires_in": 28800,
  "token_type": "Bearer",
  "scope": "user:inference ..."
}
```

The `refresh_token` field may or may not be present depending on
whether Anthropic rotates refresh tokens on each refresh. We treat
it as optional and reuse the existing refresh token if the response
omits it.

`expires_in` is seconds. We convert to `expiresAt = Date.now() +
expires_in * 1000` for Keychain storage.

### Keychain read/write

Read (already verified to work in brainstorming):
```bash
security find-generic-password -s "Claude Code-credentials" -w
```
Output is the raw JSON payload as a string on stdout.

Write:
```bash
security add-generic-password \
  -s "Claude Code-credentials" \
  -a "<account name>" \
  -w "<new JSON payload>" \
  -U                          # update if exists
```

The `-a` (account) value is the current macOS username, which is
what the official CLI uses for this entry. We get it via
`os.userInfo().username`. As a defensive fallback the implementation
also reads the existing entry's `acct` attribute by parsing the
output of `security find-generic-password -s "Claude Code-credentials"`
(without `-w`) and prefers that value if present — this protects
against the unusual case where the CLI stored credentials under a
different account name.

The new JSON payload preserves the full `claudeAiOauth` wrapper
object and all fields the CLI stores (scopes, subscriptionType,
rateLimitTier), only mutating `accessToken`, `refreshToken`, and
`expiresAt`.

### Concurrency

If two `sendMessage` calls land at the same moment and both call
`ensureFreshCredentials()`, we must not POST the refresh endpoint
twice with the same refresh token (which could trigger rotation and
invalidate one of the two outcomes). Module-level in-flight Promise:

```ts
let inFlight: Promise<void> | null = null;

export async function ensureFreshCredentials(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try { await doRefresh(); }
    finally { inFlight = null; }
  })();
  return inFlight;
}
```

This deduplicates within a single bot process. Cross-process
coordination is out of scope (see Non-goals).

### Configuration

Two new optional environment variables, both wired through
`src/utils/config.ts`:

| Variable                          | Default | Purpose                                                  |
|-----------------------------------|---------|----------------------------------------------------------|
| `CLAUDE_REFRESH_THRESHOLD_MIN`    | `30`    | Refresh when access token expires in less than N minutes |
| `CLAUDE_AUTO_REFRESH`             | `true`  | Master switch; `false` disables the refresher entirely   |

These follow the existing env-var conventions in the project (see
`MAX_SESSION_DURATION_MIN`, `PROGRESS_STALE_MS`).

## Data Flow

### Cold start, fresh token (happy path)

1. Bot starts. `index.ts` fires `ensureFreshCredentials()` and
   continues without awaiting.
2. Refresher reads Keychain, sees `expiresAt - now > 30 min`,
   returns immediately. No HTTP.
3. User sends Discord message.
4. `sendMessage` awaits `ensureFreshCredentials()` — same result,
   no-op.
5. `query()` spawns subprocess with valid token. Normal flow.

### Token near expiry

1. User sends Discord message after 7+ hours of bot idle.
2. `sendMessage` awaits `ensureFreshCredentials()`.
3. Refresher reads Keychain, sees `expiresAt - now < 30 min`.
4. Refresher POSTs to refresh endpoint with stored refreshToken.
5. Response contains new accessToken, expires_in, optionally new
   refreshToken.
6. Refresher writes the merged JSON back to Keychain (preserving
   scopes/subscriptionType/rateLimitTier).
7. `ensureFreshCredentials()` resolves; `query()` spawns. Subprocess
   reads the just-written Keychain entry and uses the fresh
   accessToken.

Expected added latency on this path: ~300-800ms (one HTTPS round
trip plus two `security` exec calls). Discord users already wait
seconds for Claude responses, so this is invisible in practice.

### Refresh token also expired (rare, real)

1. Bot has been offline for 60+ days. Refresh token has hit its TTL.
2. User sends message.
3. `ensureFreshCredentials()` POSTs refresh endpoint.
4. Endpoint returns 401 or 400 with "invalid_grant".
5. Refresher logs the failure. Does NOT write Keychain (preserves
   the existing tokens so the user can inspect them if needed).
6. `sendMessage` proceeds to `runQuery()`.
7. `claude` subprocess fails with auth error.
8. Existing `authKeywords` detection in `session-manager.ts` fires
   the Discord "please run `claude login`" message. User runs it on
   the host machine, new credentials land in Keychain, all future
   refreshes work.

This is the existing behavior, preserved as the safety net.

### Non-macOS platform

1. Bot starts on Linux/Windows/WSL.
2. `ensureFreshCredentials()` checks `process.platform`, sees it's
   not `"darwin"`, returns immediately.
3. Everything else proceeds with existing behavior.

No regression, no warning spam.

## Error Handling

| Failure mode                          | Behavior                                              |
|---------------------------------------|-------------------------------------------------------|
| `process.platform !== "darwin"`       | Silent no-op (planned non-support)                    |
| `security` binary not found           | Log once, then permanent no-op for the process       |
| Keychain entry missing                | Log warning, no-op (user has never run `claude login`)|
| Keychain JSON malformed               | Log error with the raw bytes redacted, no-op         |
| Refresh endpoint 401 / `invalid_grant`| Log warning, no Keychain write, fall through to existing path |
| Refresh endpoint 5xx / timeout        | One retry after 500ms backoff; if still failing, log and fall through |
| Refresh endpoint returns malformed JSON| Log error, no Keychain write                         |
| Keychain write fails                  | Log error (will retry next call when token still close to expiry) |

**No failure path throws** out of `ensureFreshCredentials()`. The
function is wrapped in a top-level try/catch as a defense in depth.

Logging follows the project's existing pattern: `console.warn` or
`console.error` with a `[credentials-refresher]` prefix. Tokens
themselves are NEVER logged — only failure reasons, status codes,
and bounded metadata.

## Testing

New file: `src/claude/credentials-refresher.test.ts`. Vitest
following existing project conventions (see
`src/security/guard.test.ts`).

### Unit tests (no real Keychain, no real HTTP)

1. **Non-darwin platform**: stub `process.platform = "linux"`,
   assert no `security` exec, no HTTP, function resolves silently.
2. **Token still fresh**: stub Keychain reader to return creds with
   `expiresAt = now + 2h`. Assert no HTTP call. Assert no Keychain
   write.
3. **Token near expiry, successful refresh**: stub Keychain reader,
   stub `fetch` to return valid token response. Assert correct POST
   body (grant_type, refresh_token, client_id). Assert Keychain
   write was called with merged payload that preserves
   `subscriptionType` and `scopes` from the original.
4. **Refresh response omits refresh_token**: assert the original
   refreshToken is preserved in the Keychain write.
5. **Refresh response 401**: assert no Keychain write. Assert no
   throw.
6. **Refresh response 503**: assert one retry, then no Keychain
   write if retry also fails.
7. **Concurrent calls**: invoke `ensureFreshCredentials()` 5 times
   in `Promise.all`. Assert `fetch` called exactly once. Assert
   Keychain write called exactly once.
8. **Malformed Keychain JSON**: assert no throw, no HTTP, no
   Keychain write.
9. **CLAUDE_AUTO_REFRESH=false**: assert function returns
   immediately, no Keychain read.

### Integration check (manual, documented in TESTING.md)

After landing, do a manual smoke test on macOS:
1. Bot running, valid Keychain creds.
2. Force `expiresAt` to `Date.now() + 60000` via `security
   add-generic-password -U` (write a tampered payload).
3. Send a Discord message.
4. Verify in logs: `[credentials-refresher]` line indicating a
   refresh was performed.
5. Verify Keychain (`security find-generic-password -w`) now has a
   new `accessToken` and an `expiresAt` ~8 hours out.

### What we do NOT test

- Real HTTP to `platform.claude.com`. The CI environment doesn't
  have OAuth credentials and we should not hit the live endpoint
  from tests.
- Cross-platform Keychain APIs. macOS only for v1.

## Open Questions

None blocking. The following are explicit decisions, recorded here
to prevent revisiting during implementation:

- **CLIENT_ID choice**: Use
  `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (the Claude Code CLI client
  ID extracted from the bundled SDK). The alternative
  `22422756-60c9-4084-8eb7-27705fd5cf9a` is the Claude AI / Console
  client ID and would not match the refresh token's grant context.
- **Threshold 30 min**: Conservative enough that even slow networks
  / retries finish before token expires; tight enough that we
  rarely refresh unnecessarily. Configurable for users who want
  different tradeoffs.
- **Startup refresh is fire-and-forget**: Awaiting it would block
  bot login on a remote API call. Letting it run in parallel with
  Discord login costs nothing — the first `sendMessage` will await
  the same `inFlight` promise if needed.

## Implementation Order (preview, not the plan)

The implementation plan (next step via writing-plans skill) will
break this into commits roughly in this order, each independently
testable:

1. New module skeleton + tests for non-darwin no-op and threshold
   check (no network code yet).
2. Keychain read via `security` exec, plus tests with a stubbed
   exec.
3. `callRefreshEndpoint` with stubbed `fetch`, plus tests for
   success / 401 / 5xx / malformed.
4. Keychain write, plus integration with read to round-trip the
   payload shape.
5. In-flight deduplication.
6. Wire into `session-manager.ts` `sendMessage()` and
   `index.ts` startup.
7. Env var config additions in `src/utils/config.ts`.
8. Manual smoke test on macOS, update TESTING.md.

Each step builds on the previous, but the boundaries are clean —
the module's public API is `ensureFreshCredentials()` from step 1
onwards; later steps just fill in the body behind it.
