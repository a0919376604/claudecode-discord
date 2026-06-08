# Testing Guide

## Overview

This project uses [Vitest](https://vitest.dev/) v2 as the test runner. All tests are co-located with source files (`*.test.ts`).

## Running Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Run in watch mode (re-runs on file changes)
npx tsc --noEmit      # Type check only (no build output)
```

## Test Structure

| Test File | Tests | Target Module | Strategy |
|---|---|---|---|
| `src/claude/output-formatter.test.ts` | 29 | Message splitting, code block fence handling, Discord embed/button creation | No mocking — pure logic + discord.js constructors work natively |
| `src/security/guard.test.ts` | 16 | User whitelist, sliding-window rate limiting, path traversal blocking, BASE_PROJECT_DIR scope validation | Mock `getConfig()`, `vi.spyOn(fs)`, `vi.useFakeTimers()` |
| `src/utils/config.test.ts` | 8 | Zod env validation, singleton caching, `process.exit` on error | `vi.resetModules()` + dynamic `import()` per test |
| `src/db/database.test.ts` | 12 | Project/Session CRUD operations | In-memory SQLite via `better-sqlite3` constructor mock |
| `src/bot/commands/sessions.test.ts` | 12 | JSONL session parsing, `findSessionDir`, malformed JSON handling | Real temp files (`fs.mkdtempSync`) + `os.homedir()` mock |
| **Total** | **77** | | |

## What Each Test Covers

### output-formatter (29 tests)

- **formatStreamChunk**: Truncation at 1900 chars, empty string handling
- **splitMessage**: Newline-based splitting, forced split for long lines, code block fence preservation (with/without language specifier), multiple code blocks
- **createToolApprovalEmbed**: Field generation per tool type (Edit, Bash, Write, generic), button customId format, content truncation
- **createResultEmbed**: Cost display toggle, duration formatting, description truncation
- **createAskUserQuestionEmbed**: Single-select (buttons), multi-select (StringSelectMenu), question indexing, row splitting (5 buttons per row)
- **createStopButton / createCompletedButton**: CustomId format, disabled state

### guard (16 tests)

- **isAllowedUser**: Whitelist match, case sensitivity, empty string rejection
- **checkRateLimit**: Within-limit requests, over-limit blocking, 60s window reset, per-user independence
- **validateProjectPath**: Path traversal (`..`) blocking before fs calls, BASE_PROJECT_DIR scope enforcement, non-existent path, non-directory path, valid directory

### config (8 tests)

- Valid config parsing from `process.env`
- `ALLOWED_USER_IDS` comma+space splitting
- `RATE_LIMIT_PER_MINUTE` integer coercion, `SHOW_COST` boolean coercion
- `process.exit(1)` on missing required variables
- Singleton caching (same reference on repeated calls)

### database (12 tests)

- Project CRUD: register, get, getAll (guild filter), unregister (cascade delete), auto-approve toggle
- Session CRUD: upsert, get (latest by channel), update status, getAll (JOIN with projects)

### sessions (12 tests)

- **findSessionDir**: Missing `~/.claude/projects`, simple path encoding match, no-match fallback
- **getLastAssistantMessage**: Array/string content, multi-line (returns last line), no assistant messages, malformed JSON skip, whitespace-only skip, multiple text blocks
- **getLastAssistantMessageFull**: Returns full text, empty file handling

## Adding New Tests

1. Create `<module>.test.ts` next to the source file
2. Import from the source using `.js` extension (ESM convention)
3. Mock external dependencies (`vi.mock()`) — avoid mocking the module under test
4. Run `npm test` to verify

## OAuth token auto-refresh (macOS only)

Verifies that the bot proactively refreshes the Claude Code OAuth
access token before it expires, so the user never sees the "please
run `claude login`" prompt during normal operation.

**Prereqs:** macOS, bot logged in via `claude login` at least once,
bot stopped.

> If anything goes wrong, run `claude login` to overwrite the Keychain entry with a fresh, valid set of credentials.

1. Inspect the current Keychain entry — note the `expiresAt`:
   ```bash
   security find-generic-password -s "Claude Code-credentials" -w \
     | python3 -c 'import sys,json; d=json.load(sys.stdin)["claudeAiOauth"]; print("expiresAt:", d["expiresAt"], "now:", __import__("time").time()*1000)'
   ```

2. Tamper the entry so the token "expires" 1 minute from now (this
   only changes the timestamp; the actual access token is still
   valid):
   ```bash
   CURRENT=$(security find-generic-password -s "Claude Code-credentials" -w)
   NEW_EXPIRES=$(python3 -c 'import time; print(int(time.time()*1000) + 60000)')
   PAYLOAD=$(python3 -c "import json,sys; d=json.loads('''$CURRENT'''); d['claudeAiOauth']['expiresAt']=$NEW_EXPIRES; print(json.dumps(d))")
   security add-generic-password -s "Claude Code-credentials" -a "$USER" -w "$PAYLOAD" -U
   ```

3. Start the bot: `npm run dev`. Within a few seconds the log should
   contain:
   ```
   [credentials-refresher] Refreshed access token (valid ~8h).
   ```

4. Re-inspect the Keychain entry. `expiresAt` should now be ~8 hours
   in the future, and the `accessToken` value should differ from
   what it was in step 1.

**Negative test — disable the feature:**

Stop the bot, set `CLAUDE_AUTO_REFRESH=false` in `.env`, restart.
After tampering `expiresAt` again as in step 2, the log should NOT
contain the refresh line, and sending a Discord message should
eventually surface the existing "please run `claude login`" prompt
via the bot's auth-error detection.

## Credentials Heartbeat (macOS only)

The bot periodically refreshes the Claude Code OAuth token in the
background so the user is not forced to re-login during idle
periods. To verify the heartbeat end-to-end:

All commands below are tested on macOS. They use `node -e 'console.log(Date.now())'` for millisecond timestamps because BSD `date` does not support `%3N`. The Keychain write captures the modified JSON into a shell variable first, because `security add-generic-password -w` takes the password as an argument (not stdin).

### Steady-state refresh

1. Confirm you have a valid Keychain entry and see when it expires:
   ```bash
   security find-generic-password -s "Claude Code-credentials" -w \
     | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d).claudeAiOauth; console.log('expires in', ((o.expiresAt - Date.now()) / 3_600_000).toFixed(2), 'h')})"
   ```
2. Set fast-tick overrides in `.env`:
   ```
   CLAUDE_REFRESH_INTERVAL_MIN=2
   CLAUDE_REFRESH_THRESHOLD_MIN=1
   ```
3. Tamper `expiresAt` to 90 seconds from now:
   ```bash
   NEAR_FUTURE_MS=$(node -e 'console.log(Date.now() + 90_000)')
   NEW_PAYLOAD=$(
     security find-generic-password -s "Claude Code-credentials" -w \
       | jq -c --argjson e "$NEAR_FUTURE_MS" '.claudeAiOauth.expiresAt = $e'
   )
   security add-generic-password -s "Claude Code-credentials" \
     -a "$(whoami)" -w "$NEW_PAYLOAD" -U
   ```
4. Run `npm run dev`. Within ~2 minutes you should see in the bot logs:
   ```
   [credentials-refresher] Refreshed access token (valid ~8h).
   ```
5. Confirm the Keychain now holds a fresh expiry (~8h out) using the
   same `node -e` one-liner from step 1.

### Revoke notification

1. Tamper the `refreshToken` to a known-bad value AND push `expiresAt`
   near-future so the heartbeat tries (and fails) to refresh next tick:
   ```bash
   NEAR_FUTURE_MS=$(node -e 'console.log(Date.now() + 90_000)')
   NEW_PAYLOAD=$(
     security find-generic-password -s "Claude Code-credentials" -w \
       | jq -c --argjson e "$NEAR_FUTURE_MS" '
           .claudeAiOauth.expiresAt = $e
           | .claudeAiOauth.refreshToken = "sk-ant-ort01-INVALID"
         '
   )
   security add-generic-password -s "Claude Code-credentials" \
     -a "$(whoami)" -w "$NEW_PAYLOAD" -U
   ```
2. Run `npm run dev`. Within `CLAUDE_REFRESH_INTERVAL_MIN` minutes
   the bot owner (first entry in `ALLOWED_USER_IDS`) should receive
   a Discord DM containing the bilingual EN+KR re-login instructions.
   Bot logs should show:
   ```
   [credentials-refresher] Refresh rejected (401); refresh token likely revoked or expired. ...
   [heartbeat] Sent revoke notification DM to first allowed user.
   ```
3. Wait another tick — no second DM should arrive. Bot logs continue
   to show the 401 from the refresher, but the heartbeat is now silent.
4. Restore valid creds by running `claude login` on the host. On the
   next heartbeat tick after re-auth (or the next user message,
   whichever comes first), `notifiedRevoked` resets and the DM
   capability is restored.

### Cleanup

Restore `.env` to defaults (remove the test overrides) before
returning the bot to normal use.

## VPN Keep-Alive (macOS only, opt-in)

The bot periodically pings the dev servers from
`~/.config/devsync/config.toml` to keep the FortiClient VPN tunnel
hot, and DMs the first `ALLOWED_USER_IDS` entry if the VPN status
detection reports the tunnel is down. The feature is OFF by
default; enable with `VPN_KEEPALIVE_ENABLED=true` in `.env`.

Prerequisites for this smoke test:
- macOS
- FortiClient VPN installed
- `~/bin/vpn-status.sh` present (the leric-style detector)
- `~/.config/devsync/config.toml` with at least one `[servers.*]`
- A Discord bot with `ALLOWED_USER_IDS[0]` set to a user whose
  DMs the bot can reach

### Steady-state pinging

1. Set fast-tick overrides in `.env`:
   ```
   VPN_KEEPALIVE_ENABLED=true
   VPN_KEEPALIVE_INTERVAL_SEC=15
   ```
2. Connect VPN (`/vpn connect`, or click FortiClient).
3. In another terminal, sniff ICMP on the tunnel interface (replace
   `utun4` with whatever `vpn-status.sh` reports):
   ```bash
   sudo tcpdump -i utun4 icmp
   ```
4. Run `npm run dev`. Within ~15 seconds you should see one ICMP
   echo request per configured server in the tcpdump output, and
   in the bot logs:
   ```
   [vpn-keepalive] VPN up on utun4 (10.x.x.x).
   ```
5. Repeat every interval. No Discord DM arrives.

### Drop notification

1. Disconnect VPN (`/vpn disconnect` or click the FortiClient
   button).
2. Within `VPN_KEEPALIVE_INTERVAL_SEC` seconds, the bot owner
   (first entry in `ALLOWED_USER_IDS`) should receive a Discord DM
   containing all three languages (EN, KR, zh-TW). Bot logs show:
   ```
   [vpn-keepalive] Sent VPN-down DM to first allowed user.
   ```
3. Wait another tick. NO second DM. Bot logs show:
   ```
   [vpn-keepalive] VPN still down, no DM.
   ```
4. Reconnect VPN. Within one tick, bot logs show:
   ```
   [vpn-keepalive] VPN recovered.
   [vpn-keepalive] VPN up on utun4 (10.x.x.x).
   ```
5. Disconnect again. A NEW DM should arrive (the recovery reset
   `notifiedDown`).

### Script missing / opt-in error

1. Temporarily rename the script to simulate misconfiguration:
   ```bash
   mv ~/bin/vpn-status.sh ~/bin/vpn-status.sh.disabled
   ```
2. Restart the bot. Within `VPN_KEEPALIVE_INTERVAL_SEC` seconds, a
   DM arrives with the `script_missing` variant (explicitly
   mentioning `~/bin/vpn-status.sh` and
   `VPN_KEEPALIVE_ENABLED=false`).
3. Restore the script:
   ```bash
   mv ~/bin/vpn-status.sh.disabled ~/bin/vpn-status.sh
   ```

### Cleanup

Restore `.env` to defaults (remove the test overrides or set
`VPN_KEEPALIVE_ENABLED=false`) before returning the bot to normal
use.
