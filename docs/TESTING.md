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
