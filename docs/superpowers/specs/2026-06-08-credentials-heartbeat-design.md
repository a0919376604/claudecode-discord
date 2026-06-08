# OAuth Credentials Heartbeat — Periodic Refresh + Idle-Time DM Notification

Date: 2026-06-08
Status: Draft (pending user review)
Branch: TBD (to be created during plan execution)
Scope: macOS only for v1
Builds on: `docs/superpowers/specs/2026-05-26-oauth-token-auto-refresh-design.md`

## Summary

The existing OAuth refresher in `src/claude/credentials-refresher.ts`
only runs on two events: bot startup and the start of each user
`sendMessage()`. If the bot sits idle for longer than the access
token's lifetime (~8 hours), both the access token and the refresh
token expire together and the user is forced to run `claude login`
again on the host machine.

This spec adds a periodic in-process timer that calls
`ensureFreshCredentials()` every 60 minutes regardless of user
activity, so the refresh token gets rotated well before any plausible
TTL boundary. When the refresh endpoint reports a permanent failure
(refresh token revoked or expired), the heartbeat module DMs the first
`ALLOWED_USER_IDS` entry with re-login instructions, so the user finds
out immediately rather than the next time they happen to try the bot.

The change is small in surface area but closes a real failure mode
the user has been hitting repeatedly: idle 5+ hours → no proactive
refresh → next message fails with auth error.

## Motivation

Brainstorm session on 2026-06-08 walked through the symptom ("Claude
Code asks me to log in again every 5-8 hours, even though Codex stays
logged in for months") and inspected the actual token in macOS
Keychain. Findings:

- `accessToken` lifetime is ~8 hours, tracked via `expiresAt` field.
- `refreshToken` has no client-side expiry tracked. Empirically it
  appears to die on idle within a window of similar magnitude to the
  access token's lifetime.
- The existing refresher works correctly when triggered, but is only
  triggered by user activity. During idle periods it never fires.
- Codex's CLI does not exhibit this problem because OpenAI's refresh
  tokens are long-lived (or refreshed via a daemon). Anthropic's
  shorter window appears to be a deliberate anti-abuse design choice
  for the Max subscription tier (preventing background long-running
  jobs without periodic human re-auth).

The bot is a 24/7 long-running process. It has all the information
needed to keep credentials alive in the background — the existing
refresher does it correctly when called, it just isn't called often
enough.

This is also CLAUDE.md principle 수동 조치 금지 ("no manual user
steps") again: idle-period token death is a code problem, not a user
problem. And principle 에러 시 사용자 안내 ("notify the user on
error"): when refresh genuinely fails, the user should be told
immediately, not the next time they try to use the bot.

## Relationship to existing code

- **`src/claude/credentials-refresher.ts`**: Public API extended.
  `ensureFreshCredentials()` changes return type from `Promise<void>`
  to `Promise<RefreshOutcome>` (discriminated union). Existing
  callsites (`index.ts:77`, `session-manager.ts:148`) drop the return
  value via `void` or untyped `await` — they need no behavior change
  but TypeScript may require a one-line tweak per callsite to satisfy
  `noUnusedLocals`. Internal behavior of the refresher is unchanged.

- **`src/claude/session-manager.ts` re-login prompt** (lines around
  613-618 and 691-696): Stays exactly as today. It is the fallback
  for the case where heartbeat hasn't yet noticed a revoked token
  (e.g., user sends a message in the small window between the actual
  revocation and the next heartbeat tick).

- **`src/wakeup/bootstrap.ts`**: Heartbeat module mirrors its start /
  stop lifecycle pattern but is otherwise independent. The wakeup
  module is for user-facing scheduled reminders; the heartbeat module
  is internal credential plumbing. They share no state.

- **`src/utils/config.ts`**: Two existing env vars
  (`CLAUDE_AUTO_REFRESH`, `CLAUDE_REFRESH_THRESHOLD_MIN`) are reused
  as-is. One new env var (`CLAUDE_REFRESH_INTERVAL_MIN`) is added.

## Non-goals

- **Linux / Windows / WSL support.** Out of scope. Heartbeat will
  detect non-darwin platforms and not start a timer. Cross-platform
  refresh is tracked as a separate follow-up (Gap 2 from the
  brainstorm); doing it now would more than triple this spec's scope.

- **System sleep across the access-token lifetime.** If a laptop is
  suspended for 8+ hours mid-heartbeat-cycle, the `setInterval` does
  not fire and both tokens can die together by the time the system
  wakes. Solving this requires a launchd `WakeUp` plist or external
  scheduler, both of which sit outside the bot process. For the
  intended deployment target (Mac mini / desktop / VM running 24/7),
  this is not a real-world issue. Recorded as a known limitation.

- **Fan-out to multiple `ALLOWED_USER_IDS`.** The revoke DM goes to
  the first entry only. Notifying everyone risks "is this for me or
  for the bot owner?" confusion. The user with administrative access
  to the host machine is the only one who can run `claude login`
  anyway.

- **Auto-trigger `claude login` from the bot.** `claude login`
  requires a browser OAuth flow with user interaction. The bot
  cannot complete that flow headlessly. The DM is the most we can do.

- **Retry/backoff for transient refresh failures.** The heartbeat
  itself is a retry loop with 60-minute granularity. Refusing to add
  intra-tick backoff keeps the module simple and avoids stacking
  retries on top of the refresher's existing single-retry policy.

- **Cross-process coordination.** Same caveat as the parent spec:
  if a second process (e.g., the user running `claude` interactively)
  refreshes the same Keychain entry, the loser of the rotation race
  falls back to the existing auth-error path. v1 does not coordinate.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ src/claude/credentials-heartbeat.ts          (NEW FILE)      │
│                                                              │
│  startCredentialsHeartbeat(client)  ◄── called from index.ts │
│    │                                                         │
│    └─ setInterval every N min ──► tick(client)               │
│                                     │                        │
│                                     ├─ await ensureFresh...  │
│                                     │      (returns Outcome) │
│                                     │                        │
│                                     └─ switch (outcome)      │
│                                          revoked → DM #1     │
│                                          others   → log only │
│                                                              │
│  stopCredentialsHeartbeat()  ◄── called from SIGINT/SIGTERM  │
└──────────────────────────────────────────────────────────────┘
              │                                ▲
              │ uses                           │ called by
              ▼                                │
┌──────────────────────────────────────────┐  ┌─────────────────┐
│ src/claude/credentials-refresher.ts      │  │ src/index.ts    │
│ (existing, lightly modified)             │  │                 │
│                                          │  │ start after     │
│ ensureFreshCredentials():                │  │   startBot()    │
│   Promise<RefreshOutcome>  ◄── widened   │  │ stop in SIGINT/ │
│                                          │  │   SIGTERM       │
└──────────────────────────────────────────┘  └─────────────────┘
```

### Module boundaries

- **`credentials-refresher`** is the only module that talks to
  Anthropic's OAuth endpoint or the macOS Keychain. It has no
  knowledge of Discord.
- **`credentials-heartbeat`** is the only module that holds a
  timer or sends a Discord DM about credentials. It has no knowledge
  of OAuth specifics (endpoints, headers, Keychain shape).
- **`index.ts`** is lifecycle glue. It does not call the refresher
  or the OAuth endpoint directly; it just starts and stops the
  heartbeat module alongside the other long-running components.

### `RefreshOutcome` type (new in refresher)

```ts
export type RefreshOutcome =
  | { status: "skipped" }
      // No refresh needed: token still outside threshold, OR
      // CLAUDE_AUTO_REFRESH=false, OR non-darwin platform.
  | { status: "refreshed"; expiresAt: number }
      // Token successfully renewed. expiresAt is the new ms epoch.
  | { status: "revoked" }
      // Refresh endpoint returned 400/401. User must run claude login.
  | { status: "transient_error" };
      // Network error, 5xx, malformed response, or Keychain write
      // failure. Heartbeat will retry on next tick.
```

The mapping from existing refresher behavior to outcomes:

| Existing behavior                                | New outcome           |
|--------------------------------------------------|-----------------------|
| `process.platform !== "darwin"` early return     | `skipped`             |
| `CLAUDE_AUTO_REFRESH=false`                      | `skipped`             |
| Keychain entry missing or unreadable             | `skipped`             |
| `needsRefresh()` returns false                   | `skipped`             |
| Refresh endpoint POST succeeds, Keychain written | `refreshed`           |
| Refresh endpoint returns 400 or 401              | `revoked`             |
| Network timeout / fetch throws (after retry)     | `transient_error`     |
| Refresh endpoint returns 5xx (after retry)       | `transient_error`     |
| Refresh response malformed JSON                  | `transient_error`     |
| Refresh response missing required fields         | `transient_error`     |
| Keychain write fails after successful refresh    | `transient_error`     |
| `inFlight` dedup: secondary call                 | (returns lead call's outcome) |

The existing `needsRefresh()` predicate, the `inFlight` dedup, and
the 400/401 vs 5xx vs network-error distinction already exist inside
the refresher — the change is purely surfacing them through the
return type. No internal refactoring of the refresh logic itself.

### `credentials-heartbeat.ts` public API

```ts
import type { Client } from "discord.js";

/**
 * Start the periodic credentials refresh timer.
 *
 * No-op (does not even register a timer) when CLAUDE_AUTO_REFRESH
 * is false or process.platform is not "darwin".
 *
 * Safe to call multiple times; second call is a no-op if a timer is
 * already running.
 */
export function startCredentialsHeartbeat(client: Client): void;

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 * Called from SIGINT/SIGTERM handlers in index.ts.
 */
export function stopCredentialsHeartbeat(): void;
```

### Internal state of `credentials-heartbeat.ts`

```ts
let timer: NodeJS.Timeout | null = null;

// Suppresses repeat-DM spam when the refresh token has been revoked.
// Cleared back to false on the next successful refresh, so a future
// re-login → expire → revoke cycle gets a fresh notification.
let notifiedRevoked = false;
```

These are module-level (singleton). The bot process is single-tenant
by design (lock file in `index.ts` enforces one process at a time),
so module-level state is the natural fit. If we ever shard or run
multiple heartbeats in-process, this would have to move to a class
instance — explicitly not in scope.

### Interval policy

- `CLAUDE_REFRESH_INTERVAL_MIN`, default `60`, range `[15, 360]`.
- Bounded below by 15: anything shorter than `CLAUDE_REFRESH_THRESHOLD_MIN`
  (default 30) wastes ticks because the refresher would no-op anyway.
- Bounded above by 360 (6 hours): longer risks crossing the
  access-token's natural ~8h expiry without a tick in between,
  defeating the purpose.
- Default 60 is the simplest correct value: at every tick, the
  refresher's existing `needsRefresh` predicate decides whether to
  actually hit the network. Most ticks are cheap no-ops; only the
  tick that lands inside the 30-minute pre-expiry window does a
  network call. Net effect is one HTTP refresh roughly every ~7.5
  hours, well before any plausible refresh-token TTL.

Implementation uses plain `setInterval`. We do NOT use `unref()` —
the timer keeping the event loop busy is desirable; the bot is meant
to be alive as long as the timer is alive.

### `index.ts` integration

```ts
import {
  startCredentialsHeartbeat,
  stopCredentialsHeartbeat,
} from "./claude/credentials-heartbeat.js";

// After startBot():
const client = await startBot();
startCredentialsHeartbeat(client);

// In each of the SIGINT and SIGTERM handlers, alongside the existing
// stopWakeupWatcher() call:
stopCredentialsHeartbeat();
```

`startBot()` currently returns `Promise<void>`. It must be changed to
return `Promise<Client>` so `index.ts` can pass the client to the
heartbeat starter. This is a one-line change inside `src/bot/client.ts`
and a corresponding `await` site update in `index.ts`. No other
callers exist.

### Configuration

| Variable                          | Default | New?      | Purpose                                                      |
|-----------------------------------|---------|-----------|--------------------------------------------------------------|
| `CLAUDE_AUTO_REFRESH`             | `true`  | existing  | Master switch. When false, heartbeat does not start.         |
| `CLAUDE_REFRESH_THRESHOLD_MIN`    | `30`    | existing  | Minutes before expiry at which a tick triggers a real refresh.|
| `CLAUDE_REFRESH_INTERVAL_MIN`     | `60`    | **new**   | Minutes between heartbeat ticks. Range 15-360.               |

The new env var follows the existing project conventions in
`src/utils/config.ts` (Zod schema, integer coercion, range
constraints). It is intentionally undocumented in the user-facing
README — it's a testability hook, not a user setting.

## Data Flow

### Steady state, bot idle (the case this spec exists for)

1. Bot starts. Heartbeat timer registered with 60-minute interval.
2. `startCredentialsHeartbeat` does NOT immediately tick — `index.ts`
   already fires `ensureFreshCredentials()` once at startup.
3. 60 minutes pass with no Discord activity.
4. Timer fires `tick(client)`.
5. `ensureFreshCredentials()` reads Keychain, sees
   `expiresAt - now > 30 min` (token is fresh: ~7h remaining),
   returns `{status: "skipped"}`.
6. Heartbeat logs nothing (skipped is the normal silent case).
7. Another 60 minutes pass. Repeat. Repeat. Repeat.
8. After approximately 6-7 hours since the last refresh, a tick lands
   inside the 30-minute threshold window. `ensureFreshCredentials()`
   POSTs the refresh endpoint, receives new tokens, writes Keychain,
   returns `{status: "refreshed", expiresAt: <new>}`.
9. Heartbeat logs `[heartbeat] Token refreshed.`. Clears
   `notifiedRevoked` (already false).
10. Cycle continues indefinitely.

### Refresh token actually revoked (rare, real)

1. User manually ran `claude logout` on the host, or Anthropic
   rotated the refresh token via another client, or the refresh
   token hit a hard server-side TTL.
2. Next heartbeat tick: refresher POSTs, endpoint returns 400/401.
3. Refresher returns `{status: "revoked"}`.
4. Heartbeat sees `notifiedRevoked === false`. **Sets
   `notifiedRevoked = true` BEFORE awaiting the DM** (claim-first
   pattern: prevents re-entry if anything inside the DM path throws
   unexpectedly).
5. Calls `notifyRevoked(client)`:
   - `client.users.fetch(ALLOWED_USER_IDS[0])`
   - `user.send(<re-login prompt, bilingual EN+KR>)`
6. Subsequent ticks see `notifiedRevoked === true` and skip the DM
   until a refresh succeeds.
6. User receives DM. Goes to host machine, runs `claude login`.
7. Next user message after re-login triggers
   `ensureFreshCredentials` via session-manager — the existing
   activity-driven path picks up the new credentials.
8. Subsequent heartbeat ticks return `{status: "skipped"}` (fresh
   token) or `{status: "refreshed"}`. The `refreshed` branch clears
   `notifiedRevoked`, restoring the DM capability for any future
   revocation event.

### Transient refresh failure (network blip, 503)

1. Tick fires during a brief Anthropic outage.
2. Refresher retries once (existing behavior), still fails.
3. Refresher returns `{status: "transient_error"}`.
4. Heartbeat logs nothing extra (refresher already logged via
   `[credentials-refresher]` prefix).
5. **No DM is sent.** Transient errors are not user-actionable.
6. 60 minutes later, next tick. Either fresh window still applies
   (skipped) or refresh succeeds. System recovers without user
   intervention.

### DM delivery failure

1. User has DMs disabled from server members, or has blocked the bot.
2. Refresher returns `{status: "revoked"}`.
3. Heartbeat sees `notifiedRevoked === false`, sets it to true
   (claim-first), then calls `notifyRevoked(client)`.
4. `client.users.fetch(...)` succeeds, but `user.send(...)` throws
   `DiscordAPIError 50007` (Cannot send messages to this user).
5. `notifyRevoked`'s internal try/catch logs
   `[heartbeat] Failed to DM revoke notice: ...` and returns.
6. `notifiedRevoked === true` remains. Next tick: still revoked, but
   skipped because of the flag. We do NOT retry the DM. (If the DM
   failed because of user settings, retrying won't help.)
7. The existing `session-manager.ts` re-login prompt continues to
   work the next time the user sends a Discord message in any
   registered channel. That path is the safety net.

This is a deliberate trade-off: silent failure of the DM channel is
acceptable because the in-channel prompt still works on next
activity. Alternative (keep retrying the DM forever) creates log spam
and doesn't help the user.

### Bot startup → heartbeat ordering

1. `loadConfig()`
2. `ensureFreshCredentials()` (fire and forget — existing call)
3. `initDatabase()`
4. `startBot()` — now returns the `Client`
5. `startCredentialsHeartbeat(client)` — registers the interval
6. `startWakeupWatcher()` — existing
7. "Bot is running!" log

If the startup `ensureFreshCredentials()` returns `revoked`, the
startup path does NOT trigger a DM (it's fire-and-forget without an
outcome handler). The first heartbeat tick 60 minutes later will
catch it and DM. This is acceptable for v1; a user who can register a
project channel after startup will also see the in-channel prompt.

Adding startup-time DM-on-revoke is a clean 5-line extension if we
decide it's worth it — but it requires `index.ts` to await and
inspect the outcome, which couples lifecycle to credential state.
Deferred unless requested.

## Error Handling

| Failure mode                                        | Behavior                                                  |
|-----------------------------------------------------|-----------------------------------------------------------|
| `process.platform !== "darwin"`                     | `startCredentialsHeartbeat` no-ops, no timer registered.  |
| `CLAUDE_AUTO_REFRESH=false`                         | Same.                                                     |
| `client.users.fetch(firstUserId)` throws            | Catch, log, set `notifiedRevoked=true`. Next tick: no DM until a refresh succeeds. |
| `user.send(...)` throws (DMs disabled, blocked)     | Same as above.                                            |
| Refresher throws (defense in depth — shouldn't happen) | Catch in tick, log, treat as `transient_error`.        |
| `setInterval` callback exception                    | `tick` is wrapped in try/catch; logs and continues. Timer is not affected. |
| Process exits mid-tick                              | Tick is fire-and-forget; if mid-await when SIGTERM lands, the await is abandoned. Acceptable. |

**The heartbeat module never throws out of its public functions.**
All paths are wrapped. This matches the refresher's existing
contract.

Logging is `[heartbeat]` prefix, matching the project's existing
`[credentials-refresher]` style. Tokens, user IDs beyond the bare
fact of "DM sent to first allowed user", and Keychain payloads are
NEVER logged.

## Testing

New file: `src/claude/credentials-heartbeat.test.ts`. Vitest, fake
timers, mocked refresher and Discord client.

### Unit tests

1. **Non-darwin no-op**: `startCredentialsHeartbeat` on stubbed
   `process.platform = "linux"`. Advance timers 24h. Assert refresher
   never called.
2. **`CLAUDE_AUTO_REFRESH=false` no-op**: same shape.
3. **Tick cadence**: configure interval=60, advance 30 min → 0 calls.
   Advance another 30 → 1 call. Another 60 → 2 calls.
4. **Stop clears timer**: register, advance 30, stop, advance 24h.
   Assert 0 refresher calls total.
5. **`skipped` outcome**: mock refresher to return
   `{status:"skipped"}`. Run 5 ticks. Assert no DM call, no
   `notifiedRevoked` mutation visible (verified via behavior, not
   internal state).
6. **`refreshed` outcome**: mock returns `{status:"refreshed",
   expiresAt: <future>}`. Assert no DM. Assert log line includes
   "refreshed".
7. **`revoked` triggers single DM**: mock returns `{status:"revoked"}`.
   Run 1 tick. Assert `client.users.fetch(ALLOWED_USER_IDS[0])` was
   called, `user.send` was called with a string containing both
   "claude login" and the bilingual KR text.
8. **Repeat `revoked` does not re-DM**: same mock, run 5 ticks.
   Assert `user.send` called exactly once total.
9. **`refreshed` after `revoked` resets DM capability**: mock
   sequence `[revoked, refreshed, revoked]`. Run 3 ticks. Assert
   `user.send` called exactly twice.
10. **`transient_error` does not DM**: mock returns
    `{status:"transient_error"}`. Run 5 ticks. Assert `user.send`
    never called.
11. **`transient_error` after `revoked` does not reset DM
    capability**: sequence `[revoked, transient_error, revoked]`.
    Assert `user.send` called exactly once.
12. **DM failure does not crash heartbeat**: mock returns `revoked`,
    `user.send` rejects with mock DiscordAPIError. Assert tick
    completes without throwing, log line written, next tick still
    fires.
13. **`client.users.fetch` failure does not crash heartbeat**:
    similar.
14. **`startCredentialsHeartbeat` is idempotent**: call twice. Assert
    only one timer registered (verified by call count after one
    interval).

### Refresher-side test updates

`src/claude/credentials-refresher.test.ts` (existing) must update
assertions from "returns void" to "returns outcome with correct
status". No new test cases — every existing case maps to one
outcome, and the table in the Architecture section enumerates the
mapping.

### Manual smoke test (documented in TESTING.md)

1. Bot running on macOS with valid Keychain creds, no Discord
   activity.
2. Set `CLAUDE_REFRESH_INTERVAL_MIN=2` (override default for the
   smoke test) and `CLAUDE_REFRESH_THRESHOLD_MIN=1`.
3. Tamper Keychain to set `expiresAt = Date.now() + 90 * 1000` (1.5
   min from now).
4. Wait for the next tick. Verify in logs:
   `[heartbeat] Token refreshed.`
5. Verify Keychain now has a new `accessToken` and an `expiresAt`
   ~8 hours out.
6. Tamper the `refreshToken` to a known-bad value. Wait for the
   next tick. Verify a Discord DM arrives at the first
   `ALLOWED_USER_IDS` entry containing the bilingual re-login text.
7. Wait for the tick after that. Verify NO second DM arrives.

### What we do NOT test

- Real Discord API. The bot's existing tests don't hit Discord and
  this one doesn't either; we mock `Client`.
- Real OAuth endpoint. Same as parent spec.
- System sleep behavior. Out of scope; documented as a known
  limitation.

## Open Questions

None blocking. Recorded explicit decisions:

- **Interval default 60 min**: Composes cleanly with the existing
  30-min threshold. Lower wastes ticks; higher risks missing the
  refresh window.
- **DM target = `ALLOWED_USER_IDS[0]`**: First-entry convention is
  the simplest "the admin" proxy. Broadcasting to all allowed users
  creates ambiguity and DM spam.
- **`notifiedRevoked` does NOT reset on `transient_error`**: A
  transient error in between revocations should not unsuppress the
  DM — the underlying revoked condition hasn't been resolved.
- **DM failure is terminal for that revocation cycle**: We don't
  keep retrying a DM that the user has blocked. The in-channel
  fallback in `session-manager.ts` remains the safety net.
- **Startup `ensureFreshCredentials()` outcome is ignored**: Keeps
  startup ordering simple. First heartbeat tick (60 min in) catches
  any revoked state.

## Implementation Order (preview, not the plan)

The implementation plan (next step via writing-plans skill) will
break this into commits roughly in this order:

1. Widen `RefreshOutcome` type in `credentials-refresher.ts`. Update
   the function signature and all internal return paths to produce
   the new outcomes. Existing tests updated to assert on outcome
   status. No new behavior yet — the refresher's network/keychain
   logic is unchanged.
2. New module `credentials-heartbeat.ts` with start/stop, timer,
   tick body, and `notifyRevoked`. Full test suite (mocked refresher
   and Discord client).
3. Add `CLAUDE_REFRESH_INTERVAL_MIN` to `src/utils/config.ts`.
4. Change `startBot()` to return `Promise<Client>` (one-line
   adjustment in `src/bot/client.ts`).
5. Wire `startCredentialsHeartbeat(client)` into `index.ts` after
   `startBot()`. Add `stopCredentialsHeartbeat()` to both SIGINT and
   SIGTERM handlers.
6. Manual smoke test on macOS per TESTING.md. Land.

Each commit is independently buildable and reviewable. Steps 1 and
2 carry the meaningful behavior change; the rest is wiring.
