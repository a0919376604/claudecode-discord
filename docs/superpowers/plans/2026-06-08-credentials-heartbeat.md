# OAuth Credentials Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a periodic in-process timer that calls `ensureFreshCredentials()` every 60 minutes so OAuth refresh tokens get rotated before they die from idle, plus a DM notification path when the refresh token is actually revoked.

**Architecture:** Widen `ensureFreshCredentials()` return type from `Promise<void>` to a discriminated `RefreshOutcome` union. Add a new `src/claude/credentials-heartbeat.ts` module that owns a `setInterval` and, on `revoked` outcome, DMs the first `ALLOWED_USER_IDS` entry. Wire start/stop into `src/index.ts` alongside the existing wakeup watcher. macOS-only for v1.

**Tech Stack:** TypeScript (ESM), Vitest with fake timers, discord.js v14, Zod v4 for config, Node's built-in `setInterval`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-credentials-heartbeat-design.md`

---

## File Structure

**New files:**
- `src/claude/credentials-heartbeat.ts` — owns the periodic timer + DM logic
- `src/claude/credentials-heartbeat.test.ts` — vitest with fake timers, mocked refresher and Discord client

**Modified files:**
- `src/claude/credentials-refresher.ts` — widen return type from `Promise<void>` to `Promise<RefreshOutcome>`; map all internal return points to outcomes
- `src/claude/credentials-refresher.test.ts` — add outcome assertions to existing tests
- `src/utils/config.ts` — add `CLAUDE_REFRESH_INTERVAL_MIN` env var
- `src/index.ts` — capture `client` from `startBot()`, call `startCredentialsHeartbeat(client)`, add `stopCredentialsHeartbeat()` to SIGINT/SIGTERM handlers
- `docs/TESTING.md` and `docs/TESTING.kr.md` — append manual smoke test instructions

**Unchanged on purpose:**
- `src/bot/client.ts` — already returns `Client`, no edit needed
- `src/claude/session-manager.ts` — its `ensureFreshCredentials()` call already discards the return value via `await`, still source-compatible after widening

---

## Task 1: Widen `RefreshOutcome` return type in refresher

**Files:**
- Modify: `src/claude/credentials-refresher.ts`
- Modify: `src/claude/credentials-refresher.test.ts`

This single task does the type widening + the corresponding existing-test updates together. The runtime behavior of the refresher does not change — only the return type. Existing call sites (`index.ts:77`, `session-manager.ts:148`) continue to compile because they ignore the return value.

The discriminated union distinguishes four cases the heartbeat module needs to act on. Mapping from existing internal branches:

| Existing branch                                  | Outcome              |
|--------------------------------------------------|----------------------|
| Non-darwin platform                              | `skipped`            |
| `CLAUDE_AUTO_REFRESH=false`                      | `skipped`            |
| Keychain entry missing / unreadable / malformed  | `skipped`            |
| `needsRefresh` returns false (still fresh)       | `skipped`            |
| Endpoint 401/400                                 | `revoked`            |
| Network error / 5xx / malformed response         | `transient_error`    |
| Keychain write fails post-refresh                | `transient_error`    |
| Success                                          | `refreshed`          |

To distinguish `revoked` from `transient_error`, `callRefreshEndpoint` (currently returns `RefreshResponse | null`) must be widened to a discriminated union too.

- [ ] **Step 1: Read current refresher to anchor context**

Run: `cat src/claude/credentials-refresher.ts | head -50`
Expected: see the top of file with `KEYCHAIN_SERVICE`, `TOKEN_URL`, etc. No behavior change yet — this step is just confirming the file you're about to edit.

- [ ] **Step 2: Write the failing test — non-darwin returns `{status:"skipped"}`**

Edit `src/claude/credentials-refresher.test.ts`. Modify the existing "no-ops on non-darwin platform" test to also assert the return value:

```typescript
  it("no-ops on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "skipped" });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/claude/credentials-refresher.test.ts -t "non-darwin"`
Expected: FAIL — TypeScript compile error "Property 'status' does not exist on type 'void'" OR the runtime assertion failing because the function still returns `undefined`.

- [ ] **Step 4: Add `RefreshOutcome` export to refresher**

Edit `src/claude/credentials-refresher.ts`. Add this export just above the existing `interface RefreshResponse` declaration (around line 27):

```typescript
export type RefreshOutcome =
  | { status: "skipped" }
  | { status: "refreshed"; expiresAt: number }
  | { status: "revoked" }
  | { status: "transient_error" };
```

- [ ] **Step 5: Change `inFlight` type and top-level function signature**

Still in `src/claude/credentials-refresher.ts`. Find the existing block (lines 112-141):

```typescript
let inFlight: Promise<void> | null = null;

// ... jsdoc comment ...
export async function ensureFreshCredentials(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await doRefresh();
    } catch (e) {
      console.warn(
        "[credentials-refresher] Unexpected error:",
        e instanceof Error ? e.message : e,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
```

Replace with:

```typescript
let inFlight: Promise<RefreshOutcome> | null = null;

/**
 * Ensure Keychain holds a non-expired Claude Code OAuth access token
 * before the caller spawns a `claude` subprocess. Idempotent: cheap
 * (no HTTP) when the token is still fresh, self-deduplicating when
 * called concurrently.
 *
 * Returns a discriminated outcome so callers (heartbeat) can act on
 * "revoked" vs "transient_error". Never throws — unexpected errors
 * are mapped to {status:"transient_error"}.
 *
 * macOS-only for v1; returns {status:"skipped"} on other platforms.
 */
export async function ensureFreshCredentials(): Promise<RefreshOutcome> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<RefreshOutcome> => {
    try {
      return await doRefresh();
    } catch (e) {
      console.warn(
        "[credentials-refresher] Unexpected error:",
        e instanceof Error ? e.message : e,
      );
      return { status: "transient_error" };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
```

- [ ] **Step 6: Change `doRefresh` signature and update all internal return points**

Find the existing `doRefresh` function (lines 245-269) and replace the entire function with:

```typescript
async function doRefresh(): Promise<RefreshOutcome> {
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return { status: "skipped" };
  if (process.platform !== "darwin") return { status: "skipped" };

  const keychain = readKeychain();
  if (!keychain) return { status: "skipped" };

  if (!needsRefresh(keychain.creds, cfg.CLAUDE_REFRESH_THRESHOLD_MIN)) {
    return { status: "skipped" };
  }

  const result = await callRefreshEndpoint(keychain.creds.refreshToken);
  if (!result.ok) {
    return { status: result.kind === "revoked" ? "revoked" : "transient_error" };
  }

  const merged: KeychainCreds = {
    ...keychain.creds,
    accessToken: result.response.access_token,
    refreshToken: result.response.refresh_token ?? keychain.creds.refreshToken,
    expiresAt: Date.now() + result.response.expires_in * 1000,
  };

  if (!writeKeychain(merged, keychain.account)) {
    return { status: "transient_error" };
  }

  const hoursLeft = Math.round((merged.expiresAt - Date.now()) / 3_600_000);
  console.log(`[credentials-refresher] Refreshed access token (valid ~${hoursLeft}h).`);
  return { status: "refreshed", expiresAt: merged.expiresAt };
}
```

- [ ] **Step 7: Change `callRefreshEndpoint` return type to a discriminated union**

Find the existing function declaration (line 151) and the `RefreshResponse` interface (lines 27-31). Add a new internal type just below `RefreshResponse`:

```typescript
type RefreshEndpointResult =
  | { ok: true; response: RefreshResponse }
  | { ok: false; kind: "revoked" | "transient" };
```

Then replace the entire `callRefreshEndpoint` function body with:

```typescript
async function callRefreshEndpoint(refreshToken: string): Promise<RefreshEndpointResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": ANTHROPIC_BETA,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.warn(
        "[credentials-refresher] Network error on refresh:",
        e instanceof Error ? e.message : e,
      );
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: false, kind: "transient" };
    }

    if (res.status === 401 || res.status === 400) {
      console.warn(
        `[credentials-refresher] Refresh rejected (${res.status}); refresh token likely revoked or expired. Discord will prompt user to re-login on next auth error.`,
      );
      return { ok: false, kind: "revoked" };
    }
    if (res.status >= 500) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      console.warn(`[credentials-refresher] Refresh endpoint ${res.status} after retry; giving up.`);
      return { ok: false, kind: "transient" };
    }
    if (!res.ok) {
      console.warn(`[credentials-refresher] Unexpected status ${res.status} from refresh endpoint.`);
      return { ok: false, kind: "transient" };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      console.warn("[credentials-refresher] Refresh response was not valid JSON.");
      return { ok: false, kind: "transient" };
    }
    const b = body as Partial<RefreshResponse>;
    if (typeof b.access_token !== "string" || typeof b.expires_in !== "number") {
      console.warn("[credentials-refresher] Refresh response missing required fields.");
      return { ok: false, kind: "transient" };
    }
    return {
      ok: true,
      response: {
        access_token: b.access_token,
        refresh_token: typeof b.refresh_token === "string" ? b.refresh_token : undefined,
        expires_in: b.expires_in,
      },
    };
  }
  return { ok: false, kind: "transient" };
}
```

- [ ] **Step 8: Run the type checker**

Run: `npx tsc --noEmit`
Expected: clean exit, no errors. If you see "Property 'status' does not exist" on the existing callers in `index.ts` or `session-manager.ts`, that's a real bug — those call sites should be using `await ensureFreshCredentials()` and discarding the result. They should compile fine because of TypeScript's "the result of a Promise can be discarded" rule. If a real error appears, post it and stop.

- [ ] **Step 9: Run the non-darwin test, verify it passes**

Run: `npx vitest run src/claude/credentials-refresher.test.ts -t "non-darwin"`
Expected: PASS.

- [ ] **Step 10: Add outcome assertions to remaining existing tests**

In `src/claude/credentials-refresher.test.ts`, add outcome assertions. Apply these edits one-at-a-time as you go through them:

In `"no-ops when CLAUDE_AUTO_REFRESH is false"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "skipped" });
```

In `"returns silently when Keychain entry is missing"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "skipped" });
```

In `"returns silently when Keychain JSON is malformed"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "skipped" });
```

In `"does not call fetch when token is well within threshold"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "skipped" });
```

In `"calls fetch when token expires within threshold"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalled();
    expect(outcome.status).toBe("refreshed");
    if (outcome.status === "refreshed") {
      expect(outcome.expiresAt).toBeGreaterThan(Date.now());
    }
```

In `"does not write Keychain on 401 (invalid_grant)"`:
```typescript
    const outcome = await ensureFreshCredentials();
    // Only the READ exec call should have happened — no write.
    const writeCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCalls).toHaveLength(0);
    expect(outcome).toEqual({ status: "revoked" });
```

In `"retries once on 5xx, then gives up"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ status: "transient_error" });
```

In `"writes refreshed creds back to Keychain preserving subscriptionType and scopes"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(outcome.status).toBe("refreshed");
    // ... keep the rest of the existing assertions
```

In `"preserves existing refresh token if response omits it"`:
```typescript
    const outcome = await ensureFreshCredentials();
    expect(outcome.status).toBe("refreshed");
    // ... keep the rest
```

In `"deduplicates concurrent calls"`:
```typescript
    const outcomes = await Promise.all([
      ensureFreshCredentials(),
      ensureFreshCredentials(),
      ensureFreshCredentials(),
      ensureFreshCredentials(),
      ensureFreshCredentials(),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const writeCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCalls).toHaveLength(1);
    // All 5 callers should see the same outcome
    for (const o of outcomes) expect(o.status).toBe("refreshed");
```

- [ ] **Step 11: Run the full refresher test suite**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: ALL tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "$(cat <<'EOF'
refactor(credentials-refresher): widen return to RefreshOutcome

Changes ensureFreshCredentials() from Promise<void> to a
discriminated Promise<RefreshOutcome> so the upcoming heartbeat
module can distinguish "user must re-login" (revoked) from
"will retry" (transient_error) from the silent cases (skipped,
refreshed).

callRefreshEndpoint internally widens to an {ok, kind} union so
the 400/401 vs 5xx/network distinction is preserved up the call
chain. Runtime behavior unchanged; existing callers ignore the
return value.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `CLAUDE_REFRESH_INTERVAL_MIN` config var

**Files:**
- Modify: `src/utils/config.ts`

Single env var, range [15, 360], default 60. No dedicated test — the field gets exercised via the heartbeat tests in Task 3 (which read `cfg.CLAUDE_REFRESH_INTERVAL_MIN` directly), and TypeScript's `strict` + `noUnusedLocals` will catch a missing schema entry the moment Task 3's heartbeat code reads it. Lighter than maintaining a config singleton-busting test, same effective coverage.

- [ ] **Step 1: Add the schema entry**

Edit `src/utils/config.ts`. Insert this entry inside the `envSchema` `z.object`, immediately after the existing `CLAUDE_REFRESH_THRESHOLD_MIN` line (currently line 37):

```typescript
  // Minutes between credentials heartbeat ticks. Lower bound 15
  // because anything shorter than CLAUDE_REFRESH_THRESHOLD_MIN
  // wastes ticks (refresher would no-op). Upper bound 360 because
  // anything longer risks idling past the access token's natural
  // ~8h expiry without a tick in between. Default 60 composes
  // cleanly with the 30-min threshold: ~7.5h between actual
  // network refreshes. Hidden knob — not advertised in README.
  CLAUDE_REFRESH_INTERVAL_MIN: z.coerce.number().int().min(15).max(360).default(60),
```

- [ ] **Step 2: Run the type checker**

Run: `npx tsc --noEmit`
Expected: clean exit. The new field is now part of `Config`.

- [ ] **Step 3: Run all existing tests to confirm no regression**

Run: `npm test`
Expected: every existing test still passes. The new env var has a default, so existing test fixtures that don't set it continue to work.

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "$(cat <<'EOF'
feat(config): add CLAUDE_REFRESH_INTERVAL_MIN env var

New optional env var for the credentials heartbeat. Default 60,
range [15, 360]. Lower bound prevents wasted ticks; upper bound
prevents idling past access-token expiry. Hidden knob — not
documented in README.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create heartbeat module — start/stop skeleton

**Files:**
- Create: `src/claude/credentials-heartbeat.ts`
- Create: `src/claude/credentials-heartbeat.test.ts`

Just the API surface and the no-op cases. No tick body yet. Tests use vitest fake timers.

- [ ] **Step 1: Write the failing test file**

Create `src/claude/credentials-heartbeat.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = {
  CLAUDE_AUTO_REFRESH: true,
  CLAUDE_REFRESH_THRESHOLD_MIN: 30,
  CLAUDE_REFRESH_INTERVAL_MIN: 60,
  ALLOWED_USER_IDS: ["111111111111111111"],
};

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

const refresherMock = vi.fn();
vi.mock("./credentials-refresher.js", () => ({
  ensureFreshCredentials: refresherMock,
}));

import {
  startCredentialsHeartbeat,
  stopCredentialsHeartbeat,
} from "./credentials-heartbeat.js";

// Minimal Client stub. Heartbeat only touches client.users.fetch().send().
function makeFakeClient(opts: { sendFn?: ReturnType<typeof vi.fn> } = {}) {
  const sendFn = opts.sendFn ?? vi.fn().mockResolvedValue(undefined);
  const fetchFn = vi.fn().mockResolvedValue({ send: sendFn });
  return {
    client: { users: { fetch: fetchFn } } as unknown as import("discord.js").Client,
    fetchFn,
    sendFn,
  };
}

describe("credentials-heartbeat", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    refresherMock.mockReset().mockResolvedValue({ status: "skipped" });
    mockConfig.CLAUDE_AUTO_REFRESH = true;
    mockConfig.CLAUDE_REFRESH_INTERVAL_MIN = 60;
    mockConfig.ALLOWED_USER_IDS = ["111111111111111111"];
  });

  afterEach(() => {
    stopCredentialsHeartbeat();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("does not register a timer on non-darwin", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // 24h
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("does not register a timer when CLAUDE_AUTO_REFRESH=false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_AUTO_REFRESH = false;
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("is idempotent — second call does not stack timers", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1h
    expect(refresherMock).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the timer", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // 30 min, no tick yet
    stopCredentialsHeartbeat();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // 24h
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("stop() is safe when no timer is running", () => {
    expect(() => stopCredentialsHeartbeat()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/claude/credentials-heartbeat.test.ts`
Expected: FAIL — "Cannot find module './credentials-heartbeat.js'".

- [ ] **Step 3: Create the heartbeat module with start/stop only**

Create `src/claude/credentials-heartbeat.ts`. `notifiedRevoked` is intentionally NOT declared here — it lands in Task 4 where it's actually used (project has `noUnusedLocals` enabled).

```typescript
import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";
import { ensureFreshCredentials } from "./credentials-refresher.js";

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic credentials refresh timer.
 *
 * No-op (does not even register a timer) when CLAUDE_AUTO_REFRESH
 * is false or process.platform is not "darwin".
 *
 * Safe to call multiple times — second call is a no-op if a timer
 * is already running.
 */
export function startCredentialsHeartbeat(client: Client): void {
  if (timer) return; // already running
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const intervalMs = cfg.CLAUDE_REFRESH_INTERVAL_MIN * 60_000;
  timer = setInterval(() => void tick(client), intervalMs);
}

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 */
export function stopCredentialsHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(_client: Client): Promise<void> {
  // Body filled out in Task 4. For now, just exercise the refresher
  // so the timer-cadence tests in Task 3 can observe the call count.
  await ensureFreshCredentials();
}
```

- [ ] **Step 4: Run type checker**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 5: Run the heartbeat tests, verify they pass**

Run: `npx vitest run src/claude/credentials-heartbeat.test.ts`
Expected: ALL 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/claude/credentials-heartbeat.ts src/claude/credentials-heartbeat.test.ts
git commit -m "$(cat <<'EOF'
feat(credentials-heartbeat): start/stop skeleton with platform guard

New module owns a setInterval that will periodically call
ensureFreshCredentials(). Skeleton commit: no-ops on non-darwin
or when CLAUDE_AUTO_REFRESH=false; idempotent start; clean stop.
Tick body wired to refresher but no outcome handling yet — that
lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tick body — cadence + DM on revoked

**Files:**
- Modify: `src/claude/credentials-heartbeat.ts`
- Modify: `src/claude/credentials-heartbeat.test.ts`

Add outcome handling, the `notifiedRevoked` claim-first flag, and the DM path. Test all 7 outcome-related behaviors.

- [ ] **Step 1: Write the failing tests for cadence + DM behavior**

Append to `src/claude/credentials-heartbeat.test.ts` (inside the `describe` block):

```typescript
  // ----- Tick cadence -----

  it("does not fire before the first interval elapses", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000); // 59 min
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("fires once at the first interval boundary", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 60 min
    expect(refresherMock).toHaveBeenCalledTimes(1);
  });

  it("fires repeatedly at the configured interval", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_REFRESH_INTERVAL_MIN = 30;
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(3);
  });

  // ----- Outcome handling -----

  it("does not DM on `skipped` outcome", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "skipped" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("does not DM on `refreshed` outcome", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "refreshed", expiresAt: Date.now() + 8 * 3_600_000 });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("does not DM on `transient_error` outcome", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "transient_error" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("DMs the first ALLOWED_USER_IDS entry on `revoked`", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const { client, fetchFn, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchFn).toHaveBeenCalledWith("111111111111111111");
    expect(sendFn).toHaveBeenCalledTimes(1);
    const sentText = sendFn.mock.calls[0][0] as string;
    expect(sentText).toContain("claude login");
    expect(sentText).toContain("재인증"); // KR copy present
  });

  it("does not DM twice for the same revocation cycle", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // tick 1 → DM
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // tick 2 → no DM
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // tick 3 → no DM
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("re-DMs after a refreshed cycle followed by another revocation", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock
      .mockResolvedValueOnce({ status: "revoked" })
      .mockResolvedValueOnce({ status: "refreshed", expiresAt: Date.now() + 8 * 3_600_000 })
      .mockResolvedValueOnce({ status: "revoked" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // DM #1
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // refreshed → reset
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // DM #2
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it("does NOT reset notifiedRevoked on transient_error", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock
      .mockResolvedValueOnce({ status: "revoked" })
      .mockResolvedValueOnce({ status: "transient_error" })
      .mockResolvedValueOnce({ status: "revoked" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // DM
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // transient, suppressed flag still set
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // revoked, but flag is still true → no DM
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  // ----- DM failure isolation -----

  it("tolerates client.users.fetch failure without crashing", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const fetchFn = vi.fn().mockRejectedValue(new Error("Unknown user"));
    const client = { users: { fetch: fetchFn } } as unknown as import("discord.js").Client;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalled();
    // Next tick should still fire (timer not broken)
    refresherMock.mockResolvedValue({ status: "skipped" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("tolerates user.send failure without crashing", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const sendFn = vi.fn().mockRejectedValue(new Error("Cannot send messages to this user"));
    const { client } = makeFakeClient({ sendFn });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalled();
    // notifiedRevoked is set even when DM fails → no repeat DM
    refresherMock.mockResolvedValue({ status: "revoked" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("tolerates refresher throwing (defense in depth)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockRejectedValue(new Error("refresher exploded"));
    const { client, sendFn } = makeFakeClient();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
    // Timer should keep firing
    refresherMock.mockResolvedValue({ status: "skipped" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-heartbeat.test.ts`
Expected: previously passing 5 tests still pass; new tests FAIL — many won't even DM because tick body is empty.

- [ ] **Step 3: Add `notifiedRevoked` flag and replace the tick body**

Edit `src/claude/credentials-heartbeat.ts`. Add the `notifiedRevoked` declaration immediately after the existing `timer` declaration:

```typescript
let timer: NodeJS.Timeout | null = null;

// Suppresses repeat-DM spam when the refresh token has been revoked.
// Cleared back to false on the next successful refresh, so a future
// re-login → expire → revoke cycle gets a fresh notification.
// NOT cleared on transient_error — the underlying revoked state
// hasn't been resolved.
let notifiedRevoked = false;
```

Then replace the placeholder `tick` function with:

```typescript
async function tick(client: Client): Promise<void> {
  let outcome: import("./credentials-refresher.js").RefreshOutcome;
  try {
    outcome = await ensureFreshCredentials();
  } catch (e) {
    // Defense in depth — refresher contract says it never throws,
    // but if it ever does we don't want the timer to die.
    console.warn(
      "[heartbeat] Refresher threw (should not happen):",
      e instanceof Error ? e.message : e,
    );
    return;
  }

  switch (outcome.status) {
    case "skipped":
      return;
    case "refreshed":
      notifiedRevoked = false; // reset DM suppression
      return;
    case "transient_error":
      // Refresher already logged. Heartbeat will retry next tick.
      // Do NOT touch notifiedRevoked — a transient error in between
      // two revocations should not unsuppress the DM.
      return;
    case "revoked":
      if (notifiedRevoked) return;
      // Claim-first: set flag BEFORE awaiting DM. This guarantees
      // we attempt the DM at most once per revocation cycle even
      // if anything inside the DM path throws unexpectedly.
      notifiedRevoked = true;
      await notifyRevoked(client);
      return;
  }
}

async function notifyRevoked(client: Client): Promise<void> {
  try {
    const cfg = getConfig();
    const firstUserId = cfg.ALLOWED_USER_IDS[0];
    if (!firstUserId) return;
    const user = await client.users.fetch(firstUserId);
    await user.send(
      "🔑 Claude Code OAuth refresh token has expired or been revoked.\n" +
      "Please open a terminal on the bot host machine and run `claude login` to re-authenticate.\n\n" +
      "🔑 Claude Code OAuth 토큰이 만료되었거나 취소되었습니다.\n" +
      "봇 호스트 머신에서 터미널을 열고 `claude login`을 실행하여 재인증해 주세요."
    );
    console.log("[heartbeat] Sent revoke notification DM to first allowed user.");
  } catch (e) {
    console.warn(
      "[heartbeat] Failed to DM revoke notice:",
      e instanceof Error ? e.message : e,
    );
  }
}
```

- [ ] **Step 4: Run type checker**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 5: Run the heartbeat tests, verify they pass**

Run: `npx vitest run src/claude/credentials-heartbeat.test.ts`
Expected: ALL tests pass (5 from Task 3 + ~13 new).

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `npm test`
Expected: ALL tests across the project pass.

- [ ] **Step 7: Commit**

```bash
git add src/claude/credentials-heartbeat.ts src/claude/credentials-heartbeat.test.ts
git commit -m "$(cat <<'EOF'
feat(credentials-heartbeat): tick body — DM first allowed user on revoke

Tick reads the RefreshOutcome from the refresher and dispatches:
- skipped / transient_error → silent
- refreshed → reset notifiedRevoked flag
- revoked → DM the first ALLOWED_USER_IDS entry with bilingual
  EN+KR re-login instructions

notifiedRevoked uses claim-first ordering (set flag before awaiting
DM) so a single revocation cycle DMs at most once even if the DM
path throws. Reset only on `refreshed`, not on `transient_error`,
so transient blips don't unsuppress.

DM failures are caught and logged; the timer keeps firing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire heartbeat into `index.ts` lifecycle

**Files:**
- Modify: `src/index.ts`

`startBot()` already returns `Client`. Just need to capture it, call start, and add stop to the signal handlers.

- [ ] **Step 1: Read current index.ts to anchor context**

Run: `cat src/index.ts`
Expected: see the file. Note the `SIGINT`, `SIGTERM`, and `exit` handlers, and the `await startBot()` line (around line 84).

- [ ] **Step 2: Add the heartbeat import**

Edit `src/index.ts`. Add this import alongside the existing claude/wakeup imports (after line 7, where `ensureFreshCredentials` is imported):

```typescript
import {
  startCredentialsHeartbeat,
  stopCredentialsHeartbeat,
} from "./claude/credentials-heartbeat.js";
```

- [ ] **Step 3: Add stop calls to both signal handlers**

In `src/index.ts`, find the existing SIGINT handler (around line 48):

```typescript
  process.on("SIGINT", () => {
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
```

Replace with:

```typescript
  process.on("SIGINT", () => {
    stopCredentialsHeartbeat();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopCredentialsHeartbeat();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
```

- [ ] **Step 4: Capture the client and start the heartbeat**

In `src/index.ts`, find this block (around lines 83-87):

```typescript
  // Start Discord bot
  await startBot();
  await startWakeupWatcher();
  console.log("Wake-up watcher started");
  console.log("Bot is running!");
```

Replace with:

```typescript
  // Start Discord bot
  const client = await startBot();
  startCredentialsHeartbeat(client);
  console.log("Credentials heartbeat started");
  await startWakeupWatcher();
  console.log("Wake-up watcher started");
  console.log("Bot is running!");
```

- [ ] **Step 5: Run type checker**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 6: Run the build to confirm production bundle compiles**

Run: `npm run build`
Expected: clean build, no errors. The tsup ESM bundle should include the new module.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: ALL tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(index): wire credentials heartbeat into bot lifecycle

Starts the heartbeat after startBot() resolves with the Client,
and stops it in both SIGINT and SIGTERM handlers alongside the
existing wakeup-watcher stop.

This closes the idle-time token death loop: even when the bot
goes hours without a user message, the heartbeat refreshes the
OAuth tokens on schedule, and DMs the bot owner if the refresh
token is irrecoverable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual smoke test instructions

**Files:**
- Modify: `docs/TESTING.md`
- Modify: `docs/TESTING.kr.md`

Add a section to both English and Korean TESTING docs describing how to verify the heartbeat works end-to-end on a real macOS machine.

- [ ] **Step 1: Read the existing TESTING.md to match its style**

Run: `cat docs/TESTING.md | head -80`
Expected: see the existing structure — headings, code fences, language. Match it.

- [ ] **Step 2: Append the heartbeat smoke test section to docs/TESTING.md**

Append to the end of `docs/TESTING.md`:

```markdown

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
```

- [ ] **Step 3: Append the same content to docs/TESTING.kr.md, translated**

Read `docs/TESTING.kr.md` first to match its tone. Then append a Korean version of the same content. The shell commands stay verbatim; only the prose/headings translate. Use the existing project terminology (heartbeat → 하트비트, refresh → 갱신, revoke → 취소/만료).

- [ ] **Step 4: Verify the markdown renders**

Run: `npx markdown-link-check docs/TESTING.md 2>&1 | tail -10 || true`
Expected: no broken links. If `markdown-link-check` isn't installed, skip — this is a soft check.

- [ ] **Step 5: Commit**

```bash
git add docs/TESTING.md docs/TESTING.kr.md
git commit -m "$(cat <<'EOF'
docs(testing): add credentials heartbeat smoke test procedure

Documents the manual macOS verification steps for both the
steady-state refresh path and the revoke-notification DM path.
Provides shell one-liners for tampering with the Keychain entry
without needing to fully log out / log back in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

After Task 6 commits, run these checks in order. Any failure → stop and fix before declaring complete.

- [ ] **Type check passes:**
  Run: `npx tsc --noEmit`
  Expected: clean exit.

- [ ] **All tests pass:**
  Run: `npm test`
  Expected: every test file green; no skips, no failures.

- [ ] **Production build succeeds:**
  Run: `npm run build`
  Expected: clean ESM bundle in `dist/`.

- [ ] **Heartbeat module is reachable from the entrypoint:**
  Run: `grep -n credentials-heartbeat dist/index.js`
  Expected: at least one match — confirms the bundler inlined the module.

- [ ] **Git log shows the expected commit sequence:**
  Run: `git log --oneline cfa99cc..HEAD`
  Expected: 6 commits, one per task, with the messages above.

- [ ] **Manual smoke test on macOS:**
  Follow the procedure in `docs/TESTING.md` "Credentials Heartbeat" section. Both the steady-state refresh and the revoke notification must work as described.

---

## Out-of-Scope Reminders

These were explicitly deferred in the spec and MUST NOT be added during plan execution:

- ❌ Linux / Windows / WSL credential refresh
- ❌ System-sleep-aware scheduling (launchd `WakeUp` plist, etc.)
- ❌ Fan-out DM to all `ALLOWED_USER_IDS` (only the first entry)
- ❌ Auto-trigger of `claude login` from the bot
- ❌ Intra-tick retry/backoff for `transient_error`
- ❌ Cross-process refresh coordination

If you encounter a strong reason to add one of these mid-implementation, stop and surface the question — do not silently expand scope.
