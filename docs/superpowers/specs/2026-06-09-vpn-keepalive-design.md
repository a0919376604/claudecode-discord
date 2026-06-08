# VPN Keep-Alive — Periodic Ping + Drop-Detection DM

Date: 2026-06-09
Status: Draft (pending user review)
Branch: TBD (to be created during plan execution)
Scope: macOS only for v1
Default: OPT-IN (env var must be set to enable; default off)

## Summary

The bot will periodically generate ICMP traffic against the dev
servers configured in `~/.config/devsync/config.toml` so the
FortiClient VPN tunnel does not drop from idle. When the VPN is
detected as disconnected, the bot DMs the first `ALLOWED_USER_IDS`
entry once per drop event with a "go reconnect" prompt. The feature
is OFF by default — it depends on user-specific files
(`~/bin/vpn-status.sh` + devsync config) and only makes sense for
the bot's primary maintainer; public open-source deployments are
unaffected.

This complements the existing devsync workflow (`/devsync start
<repo> <server>` etc.) by removing a recurring failure mode:
sessions sitting watching idle suddenly error out when the VPN
times out during a coffee break or overnight.

## Motivation

Devsync sessions on `dl01..dl04` require FortiClient VPN to resolve
the hostnames and route packets. FortiClient has an idle disconnect
timer (configured server-side, typically 5-30 min). When the user
isn't actively pushing changes, mutagen's own daemon traffic isn't
enough to keep the tunnel hot, and the VPN drops. The user finds
out via downstream errors:

- `cannot reach server` from a sync attempt
- `connection timed out` from `/devsync status`
- Silently stale remote state if mutagen retries while VPN is down

Today the user has to:

1. Notice something is wrong (delayed feedback)
2. Run `/vpn status` to confirm
3. Walk to the host machine, click Connect (cliclick is the only
   way to drive FortiClient's GUI)
4. Re-run any failed devsync ops

Adding lightweight periodic ICMP traffic against the configured
dev servers keeps the tunnel hot and avoids the disconnect
entirely in the common case. When prevention fails (genuine network
outage, machine sleep > some threshold, FortiClient process crash),
the bot still proactively notifies — same `notifiedDown`
claim-first pattern the credentials-heartbeat module uses for
revoked OAuth tokens.

This is the CLAUDE.md principle 수동 조치 금지 ("no manual user
steps") applied to a different recurring interruption: VPN
re-connection should not be a thing the user is reminded to do —
the network problem should be invisible when it can be, and
delivered as an actionable DM when it can't.

## Relationship to existing code

- **`src/bot/commands/devsync.ts`** — Already exposes
  `readServerNames()` which parses
  `~/.config/devsync/config.toml`'s `[servers.*]` headers. The
  keep-alive module imports and reuses this directly. No
  duplication.

- **`src/bot/commands/devsync.ts:386-391` (VPN hint)** — Already
  surfaces a `Check VPN: run /vpn status` hint when a devsync
  command fails with a connection-timeout-shaped error. Stays in
  place untouched as the reactive complement to the proactive
  keep-alive.

- **`~/bin/vpn-status.sh`** — Existing leric-specific script that
  inspects `ifconfig` output for a `utun*` interface with an
  RFC1918 point-to-point address (filtering Tailscale's `100.64/10`
  range). The keep-alive module spawns this script and grep-checks
  stdout for `✅` to decide VPN up/down.

- **`/vpn` slash command (~/.claude/commands/vpn.md)** — User-facing
  manual control. Stays unchanged. Keep-alive is silent unless
  VPN is down.

- **`src/claude/credentials-heartbeat.ts`** — Architectural sibling.
  Same claim-first DM suppression pattern, same lifecycle wiring
  in `src/index.ts`. The keep-alive imitates its conventions to
  keep the codebase consistent.

## Non-goals

- **Cross-platform VPN-status detection.** macOS-only. `~/bin/vpn-status.sh`
  is BSD `ifconfig`-specific; BSD `ping -W` takes milliseconds
  while Linux's takes seconds. Linux/Windows users are out of
  scope until someone explicitly asks.

- **Auto-reconnect via cliclick.** Q3 from brainstorm explicitly
  rejected this. Risk: cliclick can mis-click if FortiClient
  window position drifts, accessibility permission can lapse,
  silent failure is worse than no action. v1 ships DM-only;
  consider auto-reconnect only after observing how often the DM
  actually fires.

- **Discord button to trigger reconnect.** Same rejection as
  above. Would add Discord interaction handling complexity for
  marginal benefit over walking to the host machine.

- **Per-host failure reporting.** If only `dl03` is down (the box
  is off, not the VPN), we log it but do NOT DM. The signal we
  care about is binary: tunnel up or tunnel down.

- **TCP / SSH / DNS probe fallbacks.** v1 is pure ICMP. If a corp
  firewall ever filters ICMP between client and dev servers, add
  a TCP probe (e.g., `nc -z host 22`) as a second strategy. Not
  worth doing speculatively.

- **Hot reload of `config.toml`.** Server list is read at module
  startup. If the user edits the toml, they restart the bot to
  pick it up. Aligns with how the bot already handles all other
  config — no file watchers, no reactive plumbing.

- **Pre-ping to validate VPN before declaring it up.** We trust
  `~/bin/vpn-status.sh`. If the script says ✅ but pings fail,
  that's a separate problem (host down, ICMP filtered) and we
  log per-host failures but do NOT escalate.

- **Public open-source deployment.** This is leric-specific. Other
  bot users likely don't have devsync, vpn-status.sh, or
  dl01..dl04. Default `VPN_KEEPALIVE_ENABLED=false` so they're
  unaffected.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ src/vpn/keepalive.ts                          (NEW FILE)       │
│                                                                │
│  startVpnKeepalive(client)  ◄── called from index.ts after bot │
│    │                                                           │
│    └─ setInterval every N sec ──► tick(client)                 │
│                                     │                          │
│                                     ├─ await checkVpnStatus()  │
│                                     │      (spawns vpn-status.sh)│
│                                     │                          │
│                                     └─ switch on status        │
│                                          UP   → fire-and-forget│
│                                                 ping each      │
│                                                 server in      │
│                                                 parallel       │
│                                          DOWN → DM (once)      │
│                                                                │
│  stopVpnKeepalive()  ◄── SIGINT/SIGTERM in index.ts            │
└────────────────────────────────────────────────────────────────┘
              │ depends on                        ▲
              ▼                                   │
┌──────────────────────────────────────────┐   ┌─────────────────┐
│ src/bot/commands/devsync.ts              │   │ src/index.ts    │
│   readServerNames() — existing           │   │ start after     │
│                                          │   │  startBot()     │
│ ~/bin/vpn-status.sh — leric's script     │   │ stop in SIGINT/ │
│   stdout ✅ vs ❌                         │   │  SIGTERM        │
│                                          │   │                 │
│ macOS BSD ping (system binary)           │   │                 │
└──────────────────────────────────────────┘   └─────────────────┘
```

### Module boundaries

- **`src/vpn/keepalive.ts`** — owns the timer, the tick body, the
  `notifiedDown` claim-first flag, the DM dispatch. Knows about
  Discord. Knows ICMP ping spawning.
- **`readServerNames`** (reused from `src/bot/commands/devsync.ts`)
  — sole owner of devsync config parsing. Keep-alive imports.
- **`~/bin/vpn-status.sh`** — sole authority on whether VPN is up.
  Keep-alive spawns + grep-checks; does not re-implement the
  detection logic.
- **`src/index.ts`** — lifecycle glue. Mirrors how
  `startCredentialsHeartbeat` is wired.

### Public API

```ts
// src/vpn/keepalive.ts

import type { Client } from "discord.js";

/**
 * Start the periodic VPN keep-alive timer.
 *
 * No-op (does not register a timer) when:
 *   - VPN_KEEPALIVE_ENABLED is false (the default)
 *   - process.platform !== "darwin"
 *
 * Safe to call multiple times — second call is a no-op if a timer
 * is already running.
 */
export function startVpnKeepalive(client: Client): void;

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 */
export function stopVpnKeepalive(): void;
```

### Internal types

```ts
type VpnStatus =
  | { connected: true; iface: string; ip: string }
  | { connected: false; reason: "down" | "script_missing" | "script_error" };
```

`script_missing` and `script_error` are surfaced as `connected:
false` so the DM path triggers — the user wanted the feature ON
but the script isn't working, that's actionable.

### VPN status detection

Spawn `~/bin/vpn-status.sh` with a 3-second timeout. Parse stdout:

- If stdout starts with `✅` → parse `iface (ip)` from the trailing
  text, return `{connected: true, iface, ip}`.
- If stdout starts with `❌` → return `{connected: false, reason:
  "down"}`.
- If spawn fails (ENOENT) → return `{connected: false, reason:
  "script_missing"}`.
- If exit code non-zero or stdout unparseable → return
  `{connected: false, reason: "script_error"}`.
- If timeout → SIGKILL, return `{connected: false, reason:
  "script_error"}`.

The expansion of `~/bin/vpn-status.sh` uses `os.homedir()` —
testable.

### Ping mechanism

For each configured server name, spawn:

```
ping -c 1 -W 1000 <host>
```

- `-c 1` — one packet
- `-W 1000` — wait at most 1000ms for response (BSD ping semantics
  on macOS)
- exit 0 → reachable, exit 2 → unreachable, exit 68 → unknown host

All N pings run in parallel via `Promise.all`. Each ping's outcome
is logged at debug level (only failures surfaced) but does NOT
affect the DM path — the keep-alive's job is to generate traffic,
not to verify connectivity. Mutagen will surface real connection
problems through its own error path.

Why ICMP and not SSH/TCP:
- ICMP is the lightest possible traffic the VPN sees
- BSD `ping` is universally available on macOS, no extra deps
- Failures don't cost us anything — even a dropped packet is
  traffic from FortiClient's perspective

### Configuration

Two new env vars in `src/utils/config.ts`:

| Variable                       | Default  | Purpose                                                        |
|--------------------------------|----------|----------------------------------------------------------------|
| `VPN_KEEPALIVE_ENABLED`        | `false`  | Master switch. Must be `true` to start the timer.              |
| `VPN_KEEPALIVE_INTERVAL_SEC`   | `60`     | Seconds between ticks. Range [10, 600].                        |

Why `false` default: this feature depends on leric-specific files
(`~/bin/vpn-status.sh` + devsync's `config.toml`). Public open-source
users don't have those and would just see DM spam if it ran by
default. Opt-in is the correct default.

Why 60s interval: FortiClient idle timers are typically minutes-scale
(5-30 min). 60s gives plenty of margin. Four pings per minute is
negligible network cost. Lower bound 10s prevents accidentally
configuring a network-hammer; upper bound 600s prevents accidentally
configuring beyond the lowest plausible idle timeout.

### `src/index.ts` integration

```ts
import { startVpnKeepalive, stopVpnKeepalive } from "./vpn/keepalive.js";

// After startBot() and startCredentialsHeartbeat():
startVpnKeepalive(client);
console.log("VPN keep-alive started");

// In each SIGINT and SIGTERM handler, alongside the existing stops:
stopVpnKeepalive();
```

`startBot()` already returns `Client` (changed in the credentials-heartbeat
spec), so no further `startBot` modification is needed.

## Data Flow

### Steady state, VPN connected, devsync configured

1. Bot starts. `VPN_KEEPALIVE_ENABLED=true`, platform is darwin.
   `startVpnKeepalive` registers a 60-second interval.
2. 60 seconds elapse.
3. `tick()` fires:
   - `checkVpnStatus()` spawns `~/bin/vpn-status.sh`. Returns
     `{connected: true, iface: "utun4", ip: "10.50.10.42"}`.
   - `readServerNames()` returns `["dl01", "dl02", "dl03", "dl04"]`.
   - `Promise.all([ping("dl01"), ping("dl02"), ping("dl03"),
     ping("dl04")])`. All four exit 0 within 200ms.
   - Tick logs nothing (steady state is silent).
4. Repeat every 60 seconds. FortiClient sees regular ICMP traffic,
   never hits its idle threshold.

### VPN drops

1. User closes laptop lid for 2 hours. On wake, FortiClient has
   given up; VPN is down.
2. Next tick fires:
   - `checkVpnStatus()` returns `{connected: false, reason: "down"}`.
   - `notifiedDown === false`. **Set to true BEFORE awaiting DM**
     (claim-first — prevents re-DM if the DM path itself throws).
   - `notifyVpnDown(client)`:
     - `client.users.fetch(ALLOWED_USER_IDS[0])`
     - `user.send(<bilingual EN+KR re-connect prompt>)`
   - Log `[vpn-keepalive] VPN down — DM sent.`
3. Tick fires again 60s later. Still down. `notifiedDown === true`
   → no DM. Log line: `[vpn-keepalive] VPN still down, no DM.`
4. User receives DM on phone, walks to laptop, runs `/vpn connect`
   or clicks the FortiClient button.
5. Next tick: VPN up again. `notifiedDown === false` (reset on
   success). Pings resume. Log line: `[vpn-keepalive] VPN
   recovered.`.

### VPN drops AND comes back AND drops again

1. Tick 1: VPN down. DM sent. `notifiedDown = true`.
2. Tick 2: VPN up. `notifiedDown = false`. Pings happen.
3. Tick 3: VPN down again (genuinely different drop event). DM
   sent (because the flag was reset on the intervening recovery).

This is the same "reset on recovery" semantic that
credentials-heartbeat uses for the OAuth `revoked` outcome.

### Script missing (user enabled feature without having the script)

1. Bot starts with `VPN_KEEPALIVE_ENABLED=true`. Timer registered.
2. First tick: `~/bin/vpn-status.sh` ENOENT.
3. `checkVpnStatus` returns `{connected: false, reason:
   "script_missing"}`.
4. DM sent (`notifiedDown = true`), with a message variant that
   explicitly mentions the missing script — see Error Handling
   below.
5. User sees DM, either:
   - Realizes the feature is on by accident → sets
     `VPN_KEEPALIVE_ENABLED=false`, restart, no more DMs
   - Realizes they need to set up the script → does so, next
     tick succeeds

### `config.toml` has no servers (or is missing)

1. Bot starts. Timer registered. VPN is up.
2. Tick: `readServerNames()` returns `[]`.
3. No pings happen. Log line:
   `[vpn-keepalive] VPN up but no servers configured — nothing to ping.`
4. Repeat. No DM (VPN is up, just nothing to keep alive).

This is the "feature is enabled but useless" case. We log once per
tick at info level rather than DMing — the user did configure
`VPN_KEEPALIVE_ENABLED=true`, so they presumably plan to add servers
soon, and DM-spamming would be wrong.

To prevent log spam across many ticks, log this case AT MOST ONCE
per process-lifetime via a module-level boolean `loggedEmptyServers`.

### Bot startup → keepalive ordering

```
1. loadConfig()
2. ensureFreshCredentials() (existing, fire-and-forget)
3. initDatabase()
4. const client = await startBot()
5. startCredentialsHeartbeat(client)
6. startVpnKeepalive(client)               ← new
7. await startWakeupWatcher()
8. "Bot is running!"
```

Order between credentials-heartbeat and vpn-keepalive is arbitrary;
they don't interact. Listed after credentials-heartbeat for grouping
"things that DM the user on background failure".

## Error Handling

| Failure mode                                     | Behavior                                                          |
|--------------------------------------------------|-------------------------------------------------------------------|
| `process.platform !== "darwin"`                  | `startVpnKeepalive` no-ops, timer not registered.                 |
| `VPN_KEEPALIVE_ENABLED=false`                    | Same.                                                             |
| `~/bin/vpn-status.sh` ENOENT                     | Treat as VPN down with `reason="script_missing"`. DM (first time only). |
| `~/bin/vpn-status.sh` exit non-zero / hangs      | Treat as VPN down with `reason="script_error"`. DM (first time only). |
| `~/bin/vpn-status.sh` runs > 3s                  | SIGKILL. Treat as `script_error`.                                 |
| Spawn `ping` fails (ENOENT — should not happen)  | Log per-host. No DM. Continue.                                    |
| `ping` exits non-zero for one host but VPN status says UP | Log per-host failure. No DM. Continue.                            |
| `client.users.fetch` throws (unknown user, network) | Catch, log. `notifiedDown` still true (claim-first). Try again on recovery. |
| `user.send` throws (DMs blocked, etc.)           | Same. Existing devsync error-path hint remains the safety net.    |
| Refresher/timer/tick throws unexpectedly         | Wrapped in try/catch; logs and continues. Timer not affected.     |
| Process exits mid-tick                           | Tick is fire-and-forget on stop; mid-spawn pings get orphaned, OS reaps them. Acceptable. |

**The keep-alive module never throws out of its public functions.**
All paths are wrapped. Matches the credentials-heartbeat contract.

Logging uses `[vpn-keepalive]` prefix to match the project's
`[credentials-refresher]` / `[heartbeat]` conventions. The DM
content itself includes the failure reason (`down` vs
`script_missing` vs `script_error`) so the user knows what to fix.

### DM message variants

Each DM is sent as a single Discord message containing all three
languages, in the order EN → KR → zh-TW (matching the existing
project convention where `L()` already provides EN+KR, with zh-TW
appended for the bot owner's primary reading language). The DM
text is inline in the keep-alive module — it does NOT extend the
generic `L()` helper, which keeps the i18n infra untouched.

```
[reason="down"]
🔌 VPN appears to be disconnected.
Run `/vpn connect` on the bot host, or open FortiClient and click Connect.
Active devsync sessions will resume sync once the tunnel is back.

🔌 VPN 연결이 끊어진 것 같습니다.
봇 호스트에서 `/vpn connect`를 실행하거나 FortiClient에서 Connect를 클릭하세요.
활성 devsync 세션은 터널 복구 후 자동으로 동기화를 재개합니다.

🔌 VPN 似乎已斷線。
請在 bot 主機上執行 `/vpn connect`,或開啟 FortiClient 點擊 Connect。
活躍的 devsync session 會在 tunnel 恢復後自動繼續同步。

[reason="script_missing"]
🔌 VPN keep-alive cannot run: `~/bin/vpn-status.sh` not found.
Either disable the feature (`VPN_KEEPALIVE_ENABLED=false`) or install the script.

🔌 VPN keep-alive을 실행할 수 없습니다: `~/bin/vpn-status.sh`을 찾을 수 없습니다.
기능을 비활성화(`VPN_KEEPALIVE_ENABLED=false`)하거나 스크립트를 설치하세요.

🔌 VPN keep-alive 無法執行:找不到 `~/bin/vpn-status.sh`。
請停用此功能(`VPN_KEEPALIVE_ENABLED=false`)或安裝該腳本。

[reason="script_error"]
🔌 VPN keep-alive cannot determine status: `~/bin/vpn-status.sh` failed unexpectedly.
Check the bot log for details.

🔌 VPN keep-alive이 상태를 확인할 수 없습니다: `~/bin/vpn-status.sh`이 예상치 못한 오류를 발생시켰습니다.
자세한 내용은 봇 로그를 확인하세요.

🔌 VPN keep-alive 無法判斷狀態:`~/bin/vpn-status.sh` 發生未預期的錯誤。
請查看 bot log 取得詳情。
```

## Testing

`src/vpn/keepalive.test.ts`. Vitest fake timers; mocked `spawn` for
both `vpn-status.sh` and `ping`; mocked Discord client.

### Unit tests

1. **Non-darwin no-op** — `process.platform = "linux"`. `start`
   registers no timer; 24h elapses, no `spawn` calls.
2. **`VPN_KEEPALIVE_ENABLED=false` no-op** — same shape.
3. **Tick cadence** — interval=60, advance 30s → 0 ticks; another
   30s → 1 tick; another 60s → 2 ticks.
4. **`stop()` clears timer** — advance 30s, stop, advance 24h, no
   additional ticks.
5. **VPN up → spawns ping for every configured server** — mock
   vpn-status returns ✅, mock readServerNames returns 4 hosts,
   advance one tick. Assert `ping` spawned 4 times with the right
   args.
6. **VPN up → no DM** — same setup, assert `user.send` never
   called.
7. **VPN down (reason=down) → DM with `down` message** — mock
   vpn-status returns ❌, advance one tick. Assert
   `client.users.fetch(allowedUser)` called, `user.send` called
   with text containing `/vpn connect`.
8. **VPN down repeat → only one DM** — same setup, advance 5
   ticks. `user.send` called exactly once.
9. **VPN recovery resets DM** — sequence
   `[down, up, down]`. `user.send` called exactly twice.
10. **VPN script missing → DM with `script_missing` message** —
    mock spawn rejects with ENOENT. Assert DM text contains
    `script_missing`-specific copy.
11. **VPN script times out → `script_error`** — mock spawn that
    never resolves. Advance timers > 3s. Assert SIGKILL signal
    sent, DM with `script_error` text.
12. **VPN up but no servers configured → no ping, log once** —
    mock readServerNames returns `[]`. Advance 5 ticks. Assert
    no ping spawn calls; assert log printed exactly once.
13. **DM failure does not crash tick** — mock vpn-status returns
    ❌, mock `user.send` rejects. Assert tick completes without
    throwing; next tick still fires.
14. **`startVpnKeepalive` is idempotent** — call twice, advance
    one interval. `vpn-status.sh` spawned exactly once.
15. **DM contains all three languages for every reason variant** —
    parameterize over `down` / `script_missing` / `script_error`.
    For each: trigger the DM path, assert sent text contains a
    distinctive phrase from EN (e.g., "VPN keep-alive cannot"
    or "VPN appears"), KR (e.g., "VPN 연결이" or
    "확인할 수 없습니다"), and zh-TW (e.g., "似乎已斷線"
    or "無法判斷狀態"). Guards against accidental single-language
    regressions during future edits.

### Refactor: extract `readServerNames` to a shared location

Currently `readServerNames` lives in `src/bot/commands/devsync.ts`.
Importing from a `commands/` module into `src/vpn/` would create a
weird dependency direction (commands shouldn't be a library).

The plan will move `readServerNames` (and the small related
`reposFromLs` helper if it makes sense) into `src/utils/devsync-cli.ts`
where the spawn wrapper already lives. The Discord command file then
re-exports. This is a single small refactor with all-call-sites
updated in one commit, and no behavior change. Existing tests for
`readServerNames` move with it.

### Manual smoke test (documented in TESTING.md)

1. Set `VPN_KEEPALIVE_ENABLED=true` and `VPN_KEEPALIVE_INTERVAL_SEC=15`
   in `.env`. Restart bot.
2. With VPN connected, watch `tcpdump -i utun4 icmp` (or whichever
   interface) on the host. Within 15 seconds, ICMP echo requests
   to each `dl*` should appear.
3. Disconnect VPN (`/vpn disconnect` or click the FortiClient
   button). Within `VPN_KEEPALIVE_INTERVAL_SEC` seconds, expect a
   Discord DM with the bilingual prompt.
4. Wait another tick. Expect NO second DM.
5. Reconnect VPN. Wait one tick. Expect log line
   `[vpn-keepalive] VPN recovered.` and pings resume.
6. Disconnect again. Expect a NEW DM (the recovery reset the flag).
7. Restore `.env` defaults (`VPN_KEEPALIVE_ENABLED=false` or remove
   the line; interval back to 60).

## Open Questions

None blocking. Recorded explicit decisions:

- **Default OFF**: This feature is leric-specific. Open-source
  users get no behavior change. Trumps "make useful things on by
  default" because the failure mode of running it without the
  prerequisites is DM spam to the bot owner.
- **Ping is fire-and-forget**: We don't act on per-host ping
  failures. The keep-alive's job is to generate traffic; mutagen
  has its own error-surfacing path for genuine connectivity loss.
- **`vpn-status.sh` is the single source of truth**: Even though
  re-implementing the ifconfig check in Node would remove an
  external dependency, the script handles edge cases (Tailscale
  filtering, point-to-point flag check) that we don't want to
  duplicate.
- **`notifiedDown` does NOT reset on `script_missing`/`script_error`**:
  The underlying issue (script broken) isn't a "drop and recover"
  cycle — it's a configuration problem that persists across ticks.
  Re-DMing every tick would be spam. Reset only on a true
  `connected: true` outcome.
- **`readServerNames` migrated to `src/utils/devsync-cli.ts`**:
  See Testing section. Single-commit refactor, no behavior change.
- **No system-sleep-aware scheduling**: Same trade-off as
  credentials-heartbeat. Laptop sleep > some threshold will let
  VPN drop; we'll catch it on wake via the next tick and DM. Good
  enough for v1.

## Implementation Order (preview, not the plan)

The implementation plan (next step via writing-plans skill) will
break this into commits roughly in this order, each independently
testable:

1. Move `readServerNames` (and its existing tests) from
   `src/bot/commands/devsync.ts` to `src/utils/devsync-cli.ts`.
   Update import in `devsync.ts`. Tests stay green.
2. Add `VPN_KEEPALIVE_ENABLED` and `VPN_KEEPALIVE_INTERVAL_SEC`
   env vars to `src/utils/config.ts`.
3. New `src/vpn/keepalive.ts` skeleton — `start`/`stop` API, no-op
   when disabled or non-darwin. Tests for cadence + lifecycle.
4. Implement `checkVpnStatus` — spawn `~/bin/vpn-status.sh`,
   parse output, return discriminated union. Tests with mocked
   spawn for ✅, ❌, ENOENT, timeout, garbage.
5. Implement tick body — VPN up → fire ping per server; VPN down
   → claim-first DM. Tests for all four reason variants, DM
   suppression, recovery reset.
6. Wire `startVpnKeepalive` / `stopVpnKeepalive` into `src/index.ts`.
7. Add manual smoke test to `docs/TESTING.md` and `docs/TESTING.kr.md`.

Each commit is independently buildable and reviewable. Steps 3-5
carry the meaningful behavior; the rest is wiring + refactor.
