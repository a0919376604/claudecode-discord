# OAuth Token Auto-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the recurring "please run `claude login`" interruption by automatically refreshing the macOS Keychain OAuth token in the background before it expires, the same way VS Code's Claude Code extension does.

**Architecture:** A new `credentials-refresher.ts` module reads the Claude Code OAuth credentials from the macOS Keychain, checks `expiresAt`, and — when within 30 minutes of expiry — POSTs the stored refresh token to `https://platform.claude.com/v1/oauth/token` and writes the new credentials back to the Keychain. `session-manager.sendMessage()` and `index.ts` startup both call the public `ensureFreshCredentials()` entry point; the module deduplicates concurrent calls via a module-level in-flight promise. Non-darwin platforms silently no-op. Never throws — failure paths log and fall through to the existing Discord re-login prompt.

**Tech Stack:** TypeScript (ESM, strict, Node 20+ for native `fetch`), Vitest for tests, `node:child_process` `execFileSync` for `security` Keychain access, Zod v4 for env var validation.

**Spec:** `docs/superpowers/specs/2026-05-26-oauth-token-auto-refresh-design.md`

---

## File Structure

**New files:**
- `src/claude/credentials-refresher.ts` — module with `ensureFreshCredentials()` and internal helpers
- `src/claude/credentials-refresher.test.ts` — unit tests

**Modified files:**
- `src/utils/config.ts` — add `CLAUDE_AUTO_REFRESH` and `CLAUDE_REFRESH_THRESHOLD_MIN` to schema
- `src/claude/session-manager.ts` — call `ensureFreshCredentials()` at top of `sendMessage()`
- `src/index.ts` — fire-and-forget `ensureFreshCredentials()` after `loadConfig()`
- `docs/TESTING.md` — append a manual smoke-test recipe (English doc)
- `docs/TESTING.kr.md` — append same recipe in Korean (CLAUDE.md project supports both)

Each task below is self-contained: tests live next to the code being added, commits are atomic per task.

---

## Task 1: Add env-var config

**Files:**
- Modify: `src/utils/config.ts`

- [ ] **Step 1: Read the current config to confirm baseline**

Run: `head -30 src/utils/config.ts`
Expected: see the existing `envSchema` ending with `MAX_SESSION_DURATION_MIN`.

- [ ] **Step 2: Add two new fields to the schema**

Edit `src/utils/config.ts` — inside `envSchema = z.object({...})`, after the `MAX_SESSION_DURATION_MIN` entry, add:

```typescript
  // Refresh the Claude Code OAuth access token before it expires so
  // the user never has to re-run `claude login` while the bot is
  // running. macOS only for v1 — the refresher silently no-ops on
  // other platforms. Set to "false" to disable entirely.
  CLAUDE_AUTO_REFRESH: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Refresh the access token when it expires in less than this many
  // minutes. 30 is conservative enough to absorb retries on slow
  // networks while still avoiding gratuitous refreshes.
  CLAUDE_REFRESH_THRESHOLD_MIN: z.coerce.number().int().positive().default(30),
```

- [ ] **Step 3: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Existing tests still pass**

Run: `npm test`
Expected: all tests green (existing `guard.test.ts` mocks `getConfig` so its mock now lacks the two new fields, but the mocked tests don't read them — still passing).

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts
git commit -m "config: add CLAUDE_AUTO_REFRESH and CLAUDE_REFRESH_THRESHOLD_MIN"
```

---

## Task 2: Module skeleton + platform/master-switch gates

**Files:**
- Create: `src/claude/credentials-refresher.ts`
- Create: `src/claude/credentials-refresher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/claude/credentials-refresher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable mocked config so individual tests can override
const mockConfig = {
  CLAUDE_AUTO_REFRESH: true,
  CLAUDE_REFRESH_THRESHOLD_MIN: 30,
};

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

import { ensureFreshCredentials } from "./credentials-refresher.js";

describe("ensureFreshCredentials", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockConfig.CLAUDE_AUTO_REFRESH = true;
    mockConfig.CLAUDE_REFRESH_THRESHOLD_MIN = 30;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("no-ops on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    // mockResolvedValue is a safety net — if the implementation regresses
    // and DOES call fetch, the spy intercepts so we don't make a real HTTP
    // request from the test runner. The assertion still fails.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when CLAUDE_AUTO_REFRESH is false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_AUTO_REFRESH = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: FAIL — `Cannot find module './credentials-refresher.js'` (module doesn't exist yet).

- [ ] **Step 3: Create the module with minimal gates**

Create `src/claude/credentials-refresher.ts`:

```typescript
import { getConfig } from "../utils/config.js";

/**
 * Ensure Keychain holds a non-expired Claude Code OAuth access token
 * before the caller spawns a `claude` subprocess. Idempotent: cheap
 * (no HTTP) when the token is still fresh, self-deduplicating when
 * called concurrently.
 *
 * Never throws. Failures log and return — callers must not branch on
 * the outcome. If refresh fails, the existing auth-error path in
 * session-manager surfaces the problem to the user via Discord.
 *
 * macOS-only for v1; silently no-ops on other platforms.
 */
export async function ensureFreshCredentials(): Promise<void> {
  try {
    await doRefresh();
  } catch (e) {
    console.warn(
      "[credentials-refresher] Unexpected error:",
      e instanceof Error ? e.message : e,
    );
  }
}

async function doRefresh(): Promise<void> {
  if (!getConfig().CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;
  // Subsequent tasks fill in the rest.
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "credentials-refresher: module skeleton with platform and master-switch gates"
```

---

## Task 3: Keychain read

**Files:**
- Modify: `src/claude/credentials-refresher.ts`
- Modify: `src/claude/credentials-refresher.test.ts`

- [ ] **Step 1: Add the `child_process` mock at the top of the test file**

Edit `src/claude/credentials-refresher.test.ts`. Directly after the existing `vi.mock("../utils/config.js", ...)` block (and before the `import { ensureFreshCredentials }` line), insert:

```typescript
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
```

Then update the `beforeEach` to reset the new mock — replace the existing `beforeEach` block with:

```typescript
  beforeEach(() => {
    mockConfig.CLAUDE_AUTO_REFRESH = true;
    mockConfig.CLAUDE_REFRESH_THRESHOLD_MIN = 30;
    vi.mocked(execFileSync).mockReset();
  });
```

- [ ] **Step 2: Append the failing tests**

Append inside the outer `describe`, above the closing `});`:

```typescript
  it("calls `security find-generic-password` to read the Keychain entry", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(execFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  it("returns silently when Keychain entry is missing", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns silently when Keychain JSON is malformed", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(execFileSync).mockReturnValue("not json at all\n" as unknown as Buffer);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: FAIL — the first new test (`calls 'security find-generic-password'`) fails because `doRefresh` doesn't call `execFileSync` yet. The other two pass coincidentally (they only assert `fetch` wasn't called, which is true of the no-op too), but they will provide meaningful regression coverage after Step 4.

- [ ] **Step 4: Implement Keychain read**

Edit `src/claude/credentials-refresher.ts`. At the top, after the existing import, add:

```typescript
import { execFileSync } from "node:child_process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";

interface KeychainCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scopes: string[];
  subscriptionType: string;
  rateLimitTier?: string;
}

interface KeychainRecord {
  creds: KeychainCreds;
  account: string;
}

function readKeychain(): KeychainRecord | null {
  let raw: string;
  try {
    raw = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    console.warn(
      "[credentials-refresher] Keychain entry not found or unreadable:",
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    return null;
  }

  let parsed: { claudeAiOauth?: Partial<KeychainCreds> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[credentials-refresher] Keychain JSON malformed; ignoring.");
    return null;
  }

  const c = parsed.claudeAiOauth;
  if (
    !c ||
    typeof c.accessToken !== "string" ||
    typeof c.refreshToken !== "string" ||
    typeof c.expiresAt !== "number" ||
    !Array.isArray(c.scopes) ||
    typeof c.subscriptionType !== "string"
  ) {
    console.warn("[credentials-refresher] Keychain payload missing required fields.");
    return null;
  }

  // Account name is the macOS username (matches what the official CLI uses)
  const account = process.env.USER ?? "";
  return {
    creds: {
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      expiresAt: c.expiresAt,
      scopes: c.scopes,
      subscriptionType: c.subscriptionType,
      rateLimitTier: c.rateLimitTier,
    },
    account,
  };
}
```

Then update `doRefresh`:

```typescript
async function doRefresh(): Promise<void> {
  if (!getConfig().CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const keychain = readKeychain();
  if (!keychain) return;

  // Subsequent tasks fill in the rest.
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: PASS (5 tests). The three new tests verify `execFileSync` was called with `security find-generic-password ...`; the missing-entry and malformed-JSON paths both return null and skip `fetch`.

- [ ] **Step 6: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "credentials-refresher: read OAuth creds from macOS Keychain"
```

---

## Task 4: Threshold check

**Files:**
- Modify: `src/claude/credentials-refresher.ts`
- Modify: `src/claude/credentials-refresher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/claude/credentials-refresher.test.ts` (still inside the outer `describe`):

```typescript
  function mockKeychainCreds(overrides: Partial<{ expiresAt: number; refreshToken: string }> = {}) {
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-existing",
        refreshToken: overrides.refreshToken ?? "sk-ant-ort01-existing",
        expiresAt: overrides.expiresAt ?? Date.now() + 2 * 60 * 60 * 1000, // 2h out
        scopes: ["user:inference"],
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
      },
    });
    vi.mocked(execFileSync).mockReturnValue(payload as unknown as Buffer);
  }

  it("does not call fetch when token is well within threshold", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetch when token expires within threshold", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 min
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      })),
    );
    await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: FAIL — the second test expects `fetch` to be called but `doRefresh` doesn't call it yet.

- [ ] **Step 3: Implement threshold check**

Edit `src/claude/credentials-refresher.ts`. Add this helper above `doRefresh`:

```typescript
function needsRefresh(
  creds: KeychainCreds,
  thresholdMin: number,
  now: number = Date.now(),
): boolean {
  return creds.expiresAt - now < thresholdMin * 60_000;
}
```

Update `doRefresh`:

```typescript
async function doRefresh(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const keychain = readKeychain();
  if (!keychain) return;

  if (!needsRefresh(keychain.creds, cfg.CLAUDE_REFRESH_THRESHOLD_MIN)) return;

  // Placeholder so the "calls fetch when token expires within threshold"
  // test passes; real refresh body lands in Task 5.
  await fetch("https://platform.claude.com/v1/oauth/token");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "credentials-refresher: gate refresh on expiry threshold"
```

---

## Task 5: Call refresh endpoint

**Files:**
- Modify: `src/claude/credentials-refresher.ts`
- Modify: `src/claude/credentials-refresher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/claude/credentials-refresher.test.ts` (inside the outer `describe`):

```typescript
  it("POSTs the correct body to the refresh endpoint", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({
      expiresAt: Date.now() + 5 * 60 * 1000,
      refreshToken: "sk-ant-ort01-the-current-one",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      })),
    );
    await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://platform.claude.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "sk-ant-ort01-the-current-one",
          client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        }),
      }),
    );
  });

  it("does not write Keychain on 401 (invalid_grant)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureFreshCredentials();
    // Only the READ exec call should have happened — no write.
    const writeCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("retries once on 5xx, then gives up", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: FAIL — the new POST-body test fails because the placeholder `fetch` call doesn't set method/body; the 5xx retry test fails because the placeholder only calls fetch once.

- [ ] **Step 3: Implement the refresh endpoint call**

Edit `src/claude/credentials-refresher.ts`. Add these constants near the top:

```typescript
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}
```

Add the helper above `doRefresh`:

```typescript
async function callRefreshEndpoint(refreshToken: string): Promise<RefreshResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
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
      return null;
    }

    if (res.status === 401 || res.status === 400) {
      console.warn(
        `[credentials-refresher] Refresh rejected (${res.status}); refresh token likely revoked or expired. Discord will prompt user to re-login on next auth error.`,
      );
      return null;
    }
    if (res.status >= 500) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      console.warn(`[credentials-refresher] Refresh endpoint ${res.status} after retry; giving up.`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[credentials-refresher] Unexpected status ${res.status} from refresh endpoint.`);
      return null;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      console.warn("[credentials-refresher] Refresh response was not valid JSON.");
      return null;
    }
    const b = body as Partial<RefreshResponse>;
    if (typeof b.access_token !== "string" || typeof b.expires_in !== "number") {
      console.warn("[credentials-refresher] Refresh response missing required fields.");
      return null;
    }
    return {
      access_token: b.access_token,
      refresh_token: typeof b.refresh_token === "string" ? b.refresh_token : undefined,
      expires_in: b.expires_in,
    };
  }
  return null;
}
```

Update `doRefresh`:

```typescript
async function doRefresh(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const keychain = readKeychain();
  if (!keychain) return;

  if (!needsRefresh(keychain.creds, cfg.CLAUDE_REFRESH_THRESHOLD_MIN)) return;

  const fresh = await callRefreshEndpoint(keychain.creds.refreshToken);
  if (!fresh) return;

  // Keychain write lands in Task 6.
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "credentials-refresher: POST to OAuth refresh endpoint with retry"
```

---

## Task 6: Keychain write

**Files:**
- Modify: `src/claude/credentials-refresher.ts`
- Modify: `src/claude/credentials-refresher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/claude/credentials-refresher.test.ts` (inside the outer `describe`):

```typescript
  it("writes refreshed creds back to Keychain preserving subscriptionType and scopes", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.USER = "testuser";
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-new",
        refresh_token: "sk-ant-ort01-new",
        expires_in: 28800,
      })),
    );

    await ensureFreshCredentials();

    const writeCall = vi.mocked(execFileSync).mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCall).toBeDefined();
    const args = writeCall![1] as string[];
    const wIdx = args.indexOf("-w");
    const payload = JSON.parse(args[wIdx + 1]);
    expect(payload.claudeAiOauth.accessToken).toBe("sk-ant-oat01-new");
    expect(payload.claudeAiOauth.refreshToken).toBe("sk-ant-ort01-new");
    expect(payload.claudeAiOauth.subscriptionType).toBe("team");
    expect(payload.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(payload.claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x");
    // expiresAt should be ~now + 28800 * 1000
    const expectedExpiry = Date.now() + 28800 * 1000;
    expect(Math.abs(payload.claudeAiOauth.expiresAt - expectedExpiry)).toBeLessThan(5000);
    // -U flag for update-if-exists
    expect(args).toContain("-U");
    // -a flag with our USER env
    const aIdx = args.indexOf("-a");
    expect(args[aIdx + 1]).toBe("testuser");
  });

  it("preserves existing refresh token if response omits it", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.USER = "testuser";
    mockKeychainCreds({
      expiresAt: Date.now() + 5 * 60 * 1000,
      refreshToken: "sk-ant-ort01-original",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-new",
        // no refresh_token
        expires_in: 28800,
      })),
    );

    await ensureFreshCredentials();

    const writeCall = vi.mocked(execFileSync).mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    const args = writeCall![1] as string[];
    const payload = JSON.parse(args[args.indexOf("-w") + 1]);
    expect(payload.claudeAiOauth.refreshToken).toBe("sk-ant-ort01-original");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: FAIL — both new tests fail because no `add-generic-password` call is made yet.

- [ ] **Step 3: Implement Keychain write**

Edit `src/claude/credentials-refresher.ts`. Add the helper above `doRefresh`:

```typescript
function writeKeychain(creds: KeychainCreds, account: string): boolean {
  const payload = JSON.stringify({ claudeAiOauth: creds });
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-s", KEYCHAIN_SERVICE,
        "-a", account,
        "-w", payload,
        "-U",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return true;
  } catch (e) {
    console.warn(
      "[credentials-refresher] Failed to write Keychain:",
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    return false;
  }
}
```

Update `doRefresh` to merge and write:

```typescript
async function doRefresh(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const keychain = readKeychain();
  if (!keychain) return;

  if (!needsRefresh(keychain.creds, cfg.CLAUDE_REFRESH_THRESHOLD_MIN)) return;

  const fresh = await callRefreshEndpoint(keychain.creds.refreshToken);
  if (!fresh) return;

  const merged: KeychainCreds = {
    ...keychain.creds,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token ?? keychain.creds.refreshToken,
    expiresAt: Date.now() + fresh.expires_in * 1000,
  };

  if (writeKeychain(merged, keychain.account)) {
    const hoursLeft = Math.round((merged.expiresAt - Date.now()) / 3_600_000);
    console.log(`[credentials-refresher] Refreshed access token (valid ~${hoursLeft}h).`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "credentials-refresher: write refreshed creds back to Keychain"
```

---

## Task 7: In-flight deduplication

**Files:**
- Modify: `src/claude/credentials-refresher.ts`
- Modify: `src/claude/credentials-refresher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/claude/credentials-refresher.test.ts` (inside the outer `describe`):

```typescript
  it("deduplicates concurrent calls", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.USER = "testuser";
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-new",
        refresh_token: "sk-ant-ort01-new",
        expires_in: 28800,
      })),
    );

    await Promise.all([
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
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: FAIL — five concurrent calls trigger five fetches and five Keychain writes today.

- [ ] **Step 3: Add module-level in-flight Promise**

Edit `src/claude/credentials-refresher.ts`. Replace the body of `ensureFreshCredentials` with deduped version, leaving the function above the helpers:

```typescript
let inFlight: Promise<void> | null = null;

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

(The function-level try/catch from Task 2 moves inside the IIFE so both the deduped and the original entry path remain safe.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/claude/credentials-refresher.test.ts`
Expected: PASS (13 tests). Specifically the new concurrency test now sees 1 fetch and 1 write.

- [ ] **Step 5: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/credentials-refresher.ts src/claude/credentials-refresher.test.ts
git commit -m "credentials-refresher: deduplicate concurrent ensureFreshCredentials() calls"
```

---

## Task 8: Wire into session-manager and index startup

**Files:**
- Modify: `src/claude/session-manager.ts` (line ~82, top of `sendMessage`)
- Modify: `src/index.ts` (after `loadConfig()`, before `initDatabase()`)

- [ ] **Step 1: Add the import and call in session-manager**

Edit `src/claude/session-manager.ts`.

After the existing imports (around line 29), add:

```typescript
import { ensureFreshCredentials } from "./credentials-refresher.js";
```

In `sendMessage()`, right after the opening brace and `const channelId = channel.id;` line (around line 83), add:

```typescript
    // Best-effort: keep the macOS Keychain access token fresh before
    // we spawn a `claude` subprocess. No-op on non-darwin and when
    // the token is still well within expiry. Never throws.
    await ensureFreshCredentials();
```

- [ ] **Step 2: Add the import and call in index.ts**

Edit `src/index.ts`.

After `import { startBot } from "./bot/client.js";` add:

```typescript
import { ensureFreshCredentials } from "./claude/credentials-refresher.js";
```

After `console.log("Config loaded");` and before `initDatabase();` add:

```typescript
  // Kick off a background credential refresh so the first user
  // request after bot startup doesn't have to wait for a refresh
  // round trip. Fire-and-forget — failures log internally.
  void ensureFreshCredentials();
```

- [ ] **Step 3: Type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: All tests still pass**

Run: `npm test`
Expected: all tests green.

- [ ] **Step 5: Build succeeds**

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/session-manager.ts src/index.ts
git commit -m "session-manager+index: call ensureFreshCredentials before query and on startup"
```

---

## Task 9: Document manual smoke test

**Files:**
- Modify: `docs/TESTING.md`
- Modify: `docs/TESTING.kr.md`

- [ ] **Step 1: Read both TESTING docs to learn the section style**

Run: `head -40 docs/TESTING.md`
Run: `head -40 docs/TESTING.kr.md`

Note the section heading style and the wrapping width used.

- [ ] **Step 2: Append the smoke test section to docs/TESTING.md**

Append to `docs/TESTING.md`:

````markdown
## OAuth token auto-refresh (macOS only)

Verifies that the bot proactively refreshes the Claude Code OAuth
access token before it expires, so the user never sees the "please
run `claude login`" prompt during normal operation.

**Prereqs:** macOS, bot logged in via `claude login` at least once,
bot stopped.

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
   NEW_EXPIRES=$(($(date +%s%3N) + 60000))
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
````

- [ ] **Step 3: Append the equivalent Korean section to docs/TESTING.kr.md**

Append to `docs/TESTING.kr.md`:

````markdown
## OAuth 토큰 자동 갱신 (macOS 전용)

봇이 만료 직전에 Claude Code OAuth access token을 자동으로 갱신하여,
정상 운영 중에는 사용자가 `claude login`을 다시 실행할 필요가 없는지
확인합니다.

**전제 조건:** macOS, 최소 한 번은 `claude login`으로 로그인된 상태,
봇은 중지된 상태.

1. 현재 Keychain 항목의 `expiresAt`을 확인합니다:
   ```bash
   security find-generic-password -s "Claude Code-credentials" -w \
     | python3 -c 'import sys,json; d=json.load(sys.stdin)["claudeAiOauth"]; print("expiresAt:", d["expiresAt"], "now:", __import__("time").time()*1000)'
   ```

2. 토큰이 1분 뒤 "만료"되는 것처럼 타임스탬프만 위변조합니다 (실제
   access token은 그대로 유효):
   ```bash
   CURRENT=$(security find-generic-password -s "Claude Code-credentials" -w)
   NEW_EXPIRES=$(($(date +%s%3N) + 60000))
   PAYLOAD=$(python3 -c "import json,sys; d=json.loads('''$CURRENT'''); d['claudeAiOauth']['expiresAt']=$NEW_EXPIRES; print(json.dumps(d))")
   security add-generic-password -s "Claude Code-credentials" -a "$USER" -w "$PAYLOAD" -U
   ```

3. `npm run dev`로 봇을 실행합니다. 몇 초 안에 로그에 다음 줄이 나와야
   합니다:
   ```
   [credentials-refresher] Refreshed access token (valid ~8h).
   ```

4. Keychain 항목을 다시 확인합니다. `expiresAt`이 약 8시간 뒤로 갱신되어
   있고, `accessToken` 값이 1단계와 달라야 합니다.

**비활성화 테스트:**

봇을 중지하고 `.env`에 `CLAUDE_AUTO_REFRESH=false`를 추가한 뒤 재시작합니다.
2단계와 같이 `expiresAt`을 위변조해도 갱신 로그가 나오지 않으며, Discord
메시지를 보내면 봇의 기존 인증 오류 감지 로직이 "claude login 다시 실행해
주세요" 안내를 띄워야 합니다.
````

- [ ] **Step 4: Commit**

```bash
git add docs/TESTING.md docs/TESTING.kr.md
git commit -m "docs: smoke-test recipe for OAuth token auto-refresh"
```

---

## Verification After All Tasks

Run the full test suite plus type-check plus build to confirm the
feature integrates cleanly:

```bash
npm test && npx tsc --noEmit && npm run build
```

Expected: all green.

Then run the manual smoke test from `docs/TESTING.md` "OAuth token
auto-refresh (macOS only)" section.

---

## Self-Review Notes (post-write)

- **Spec coverage:**
  - Architecture diagram → Tasks 2, 3, 4, 5, 6, 7 each implement one box
  - Public API (`ensureFreshCredentials()`) → Task 2 establishes signature; Task 7 finalizes dedup semantics
  - Refresh endpoint contract → Task 5 (URL, headers, body, CLIENT_ID, response handling)
  - Keychain read/write → Tasks 3 and 6 (with `-U`, `-a $USER`)
  - Concurrency (in-flight Promise) → Task 7
  - Configuration (`CLAUDE_AUTO_REFRESH`, `CLAUDE_REFRESH_THRESHOLD_MIN`) → Task 1
  - All four data-flow scenarios (cold start / near expiry / refresh-token dead / non-darwin) → covered by tests in Tasks 2, 3, 4, 5
  - Error handling table → Tasks 3 (missing entry, malformed JSON), 5 (401, 5xx, network), 6 (write failure)
  - Test list (9 unit tests) → realized as 13 tests across Tasks 2–7
  - Manual smoke test in TESTING.md → Task 9

- **Type consistency:** `KeychainCreds`, `KeychainRecord`, `RefreshResponse` defined in Task 3 and reused unchanged in Tasks 5 and 6. The helper names (`readKeychain`, `needsRefresh`, `callRefreshEndpoint`, `writeKeychain`) are used consistently across tasks and in the orchestrator (`doRefresh`).

- **Placeholder scan:** No "TBD" / "implement later" / "similar to" sentinels. Each step shows actual code.

- **Test independence:** Each task's tests reuse `mockKeychainCreds` introduced in Task 4. Tasks 2-3 use simpler one-off mocks because the helper hadn't landed yet — by Task 4 the helper exists and subsequent tasks reuse it.
