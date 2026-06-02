# Wake-up Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic wake-up channel to claudecode-discord so background tasks (starting with `/run-plan` codex runs) can re-invoke a Claude session in the right Discord channel when they finish, replacing the Claude Code harness features (Monitor, ScheduleWakeup) that don't exist in Agent SDK.

**Architecture:** A new `src/wakeup/` module watches `~/.claudecode-discord/wakeups/` (atomic JSON drops) plus a legacy `/tmp/run-plan-done-*.txt` adapter. On a valid event, `WakeupWatcher.handleEvent` validates schema/channel/TTL, sends a passive Discord embed, then either calls `SessionManager.wakeUp(channelId, prompt, source)` directly (idle channel) or queues the wake-up in a new `wakeup_queue` SQLite table (active session — drained in the existing `sendMessage` finally). The `/run-plan` skill gets a ~15-line edit to write the JSON when `WAKEUP_CHANNEL_ID` + `WAKEUP_DIR` env vars are injected by the bot at `query()` launch.

**Tech Stack:** TypeScript ESM, better-sqlite3, discord.js v14, zod v4, vitest. Node ≥ 20.

---

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/wakeup/types.ts` | `WakeupPayload` zod schema, `WakeupQueueRow` DB row type, dedupe-key derivation |
| `src/wakeup/queue.ts` | `wakeup_queue` table CRUD (insert/dedupe, drainNext, peek, deleteByChannel) |
| `src/wakeup/embed.ts` | Passive Discord embed builder (per-source templates) |
| `src/wakeup/watcher.ts` | `WakeupWatcher` class: fs.watch wiring, file parsing, `handleEvent` dispatch, startup scan |
| `src/wakeup/legacy-adapter.ts` | `/tmp/run-plan-done-*.txt` → `WakeupPayload` synthesis |
| `src/wakeup/types.test.ts` | Schema validation unit tests |
| `src/wakeup/queue.test.ts` | DB CRUD + dedupe unit tests |
| `src/wakeup/embed.test.ts` | Embed builder unit tests |
| `src/wakeup/watcher.test.ts` | `handleEvent` dispatch + FS integration |
| `src/wakeup/legacy-adapter.test.ts` | Adapter unit tests |

**Modified files:**

| Path | Change |
|---|---|
| `src/db/database.ts` | Add `wakeup_queue` table to `initDatabase()` |
| `src/db/types.ts` | Add `WakeupQueueRow` type |
| `src/claude/session-manager.ts` | Add `wakeUp()` method, inject `WAKEUP_CHANNEL_ID` + `WAKEUP_DIR` into `query()` env, drain `wakeup_queue` in finally |
| `src/index.ts` | Boot `WakeupWatcher` after `initDatabase` + ensure wake-up dir exists with chmod 700 |
| `src/utils/config.ts` | Add `WAKEUP_DIR_OVERRIDE` optional env (test hook) |
| `~/.claude/skills/run-plan/SKILL.md` | Step 3 writes `channel_id=` to META; Step 4 watcher tail writes wakeup JSON |

---

### Task 1: WakeupPayload schema + dedupe key

**Files:**
- Create: `src/wakeup/types.ts`
- Create: `src/wakeup/types.test.ts`

- [ ] **Step 1: Write the failing test**

`src/wakeup/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WakeupPayloadSchema, deriveDedupeKey, isExpired } from "./types.js";

const validPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status refactor-foo",
  source: "run-plan",
  metadata: { slot: "refactor-foo", status: "DONE", commits: "+7" },
  created_at: "2026-06-01T12:00:00Z",
};

describe("WakeupPayloadSchema", () => {
  it("accepts a valid payload", () => {
    const result = WakeupPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects non-snowflake channel_id", () => {
    const bad = { ...validPayload, channel_id: "not-a-snowflake" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects channel_id shorter than 17 digits", () => {
    const bad = { ...validPayload, channel_id: "1234567890" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects channel_id longer than 20 digits", () => {
    const bad = { ...validPayload, channel_id: "1".repeat(21) };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects prompt longer than 4000 chars", () => {
    const bad = { ...validPayload, prompt: "x".repeat(4001) };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects source with disallowed chars", () => {
    const bad = { ...validPayload, source: "run plan!" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects source longer than 64 chars", () => {
    const bad = { ...validPayload, source: "a".repeat(65) };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-ISO created_at", () => {
    const bad = { ...validPayload, created_at: "yesterday" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("treats metadata as optional", () => {
    const { metadata, ...rest } = validPayload;
    expect(metadata).toBeDefined(); // touch to silence unused-var
    expect(WakeupPayloadSchema.safeParse(rest).success).toBe(true);
  });

  it("treats ttl_seconds as optional", () => {
    const result = WakeupPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    // default applies when missing
    if (result.success) expect(result.data.ttl_seconds).toBe(86400);
  });
});

describe("deriveDedupeKey", () => {
  it("uses metadata.slot when present", () => {
    expect(deriveDedupeKey("run-plan", { slot: "foo" })).toBe("run-plan:foo");
  });

  it("hashes metadata when slot missing", () => {
    const a = deriveDedupeKey("ci", { branch: "main", build: 42 });
    const b = deriveDedupeKey("ci", { build: 42, branch: "main" });
    expect(a).toBe(b); // canonical (key-sorted)
    expect(a.startsWith("ci:")).toBe(true);
    expect(a.length).toBeGreaterThan(3);
  });

  it("falls back to created_at when metadata empty", () => {
    expect(deriveDedupeKey("misc", undefined, "2026-06-01T12:00:00Z"))
      .toBe("misc:2026-06-01T12:00:00Z");
  });
});

describe("isExpired", () => {
  it("returns false for fresh payloads", () => {
    const created = new Date(Date.now() - 60_000).toISOString();
    expect(isExpired({ created_at: created, ttl_seconds: 86400 })).toBe(false);
  });

  it("returns true when ttl exceeded", () => {
    const created = new Date(Date.now() - 90_000).toISOString();
    expect(isExpired({ created_at: created, ttl_seconds: 60 })).toBe(true);
  });

  it("returns true when created_at is unparseable", () => {
    expect(isExpired({ created_at: "garbage", ttl_seconds: 86400 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wakeup/types.test.ts`
Expected: FAIL with module-not-found error for `./types.js`.

- [ ] **Step 3: Implement the schema + helpers**

`src/wakeup/types.ts`:

```ts
import { z } from "zod";
import { createHash } from "node:crypto";

// Discord snowflakes are 17-20 digits (forward-compat for future Discord changes).
const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake");

export const WakeupPayloadSchema = z.object({
  channel_id: snowflake,
  prompt: z.string().min(1).max(4000),
  source: z.string().regex(/^[a-z0-9_-]+$/, "lowercase alphanumeric/_/- only").max(64),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().refine(
    (s) => !Number.isNaN(Date.parse(s)),
    "must be an ISO 8601 date string",
  ),
  ttl_seconds: z.number().int().positive().default(86400),
});

export type WakeupPayload = z.infer<typeof WakeupPayloadSchema>;

export interface WakeupQueueRow {
  id: number;
  channel_id: string;
  source: string;
  payload_json: string;
  queued_at: number; // unix ms
  dedupe_key: string | null;
}

/**
 * Stable dedupe key for a wake-up. Same (source, slot) collapses to one entry;
 * different slots stay distinct. For metadata without a `slot` field, we
 * canonicalize the object (sorted keys) and hash so equivalent metadata
 * produces the same key regardless of key insertion order.
 */
export function deriveDedupeKey(
  source: string,
  metadata: Record<string, unknown> | undefined,
  createdAt?: string,
): string {
  if (metadata && typeof metadata.slot === "string" && metadata.slot.length > 0) {
    return `${source}:${metadata.slot}`;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    const canonical = JSON.stringify(metadata, Object.keys(metadata).sort());
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    return `${source}:${hash}`;
  }
  return `${source}:${createdAt ?? ""}`;
}

export function isExpired(input: { created_at: string; ttl_seconds: number }): boolean {
  const created = Date.parse(input.created_at);
  if (Number.isNaN(created)) return true;
  return Date.now() > created + input.ttl_seconds * 1000;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/wakeup/types.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/wakeup/types.ts src/wakeup/types.test.ts
git commit -m "feat(wakeup): add WakeupPayload schema and dedupe helpers"
```

---

### Task 2: wakeup_queue table + DB CRUD

**Files:**
- Modify: `src/db/database.ts` (add table to `initDatabase`)
- Modify: `src/db/types.ts` (re-export `WakeupQueueRow`)
- Create: `src/wakeup/queue.ts`
- Create: `src/wakeup/queue.test.ts`

- [ ] **Step 1: Write the failing test**

`src/wakeup/queue.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { setQueueDb, enqueueWakeup, drainOldest, peekOldest, deleteByChannel, countByChannel } from "./queue.js";
import type { WakeupPayload } from "./types.js";

const samplePayload: WakeupPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status foo",
  source: "run-plan",
  metadata: { slot: "foo" },
  created_at: "2026-06-01T12:00:00Z",
  ttl_seconds: 86400,
};

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE wakeup_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      dedupe_key TEXT,
      UNIQUE(channel_id, dedupe_key)
    );
    CREATE INDEX idx_wakeup_queue_channel ON wakeup_queue(channel_id, queued_at);
  `);
  return db;
}

describe("wakeup queue", () => {
  beforeEach(() => {
    setQueueDb(freshDb());
  });

  it("enqueues a wakeup and peeks it back", () => {
    enqueueWakeup(samplePayload);
    const row = peekOldest("123456789012345678");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("run-plan");
    expect(JSON.parse(row!.payload_json).prompt).toBe(samplePayload.prompt);
  });

  it("dedupes by (channel, source, slot) — newest wins", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, prompt: "/run-plan status foo NEW" });
    expect(countByChannel("123456789012345678")).toBe(1);
    const row = peekOldest("123456789012345678");
    expect(JSON.parse(row!.payload_json).prompt).toBe("/run-plan status foo NEW");
  });

  it("keeps different slots distinct", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, metadata: { slot: "bar" } });
    expect(countByChannel("123456789012345678")).toBe(2);
  });

  it("drainOldest returns and removes oldest row", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, metadata: { slot: "bar" } });
    const first = drainOldest("123456789012345678");
    expect(first).not.toBeNull();
    expect(countByChannel("123456789012345678")).toBe(1);
  });

  it("drainOldest returns null when empty", () => {
    expect(drainOldest("123456789012345678")).toBeNull();
  });

  it("deleteByChannel wipes that channel only", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, channel_id: "987654321098765432", metadata: { slot: "z" } });
    deleteByChannel("123456789012345678");
    expect(countByChannel("123456789012345678")).toBe(0);
    expect(countByChannel("987654321098765432")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wakeup/queue.test.ts`
Expected: FAIL with module-not-found for `./queue.js`.

- [ ] **Step 3: Implement queue CRUD**

`src/wakeup/queue.ts`:

```ts
import type Database from "better-sqlite3";
import { getDb } from "../db/database.js";
import { deriveDedupeKey, type WakeupPayload, type WakeupQueueRow } from "./types.js";

// Test seam — production code uses getDb(); tests inject in-memory db.
let injectedDb: Database.Database | null = null;
export function setQueueDb(db: Database.Database | null): void {
  injectedDb = db;
}
function db(): Database.Database {
  return injectedDb ?? getDb();
}

export function enqueueWakeup(payload: WakeupPayload): void {
  const dedupeKey = deriveDedupeKey(payload.source, payload.metadata, payload.created_at);
  // ON CONFLICT replaces the prior row for (channel, dedupe_key) — newest wins.
  db().prepare(`
    INSERT INTO wakeup_queue (channel_id, source, payload_json, queued_at, dedupe_key)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, dedupe_key) DO UPDATE SET
      source       = excluded.source,
      payload_json = excluded.payload_json,
      queued_at    = excluded.queued_at
  `).run(
    payload.channel_id,
    payload.source,
    JSON.stringify(payload),
    Date.now(),
    dedupeKey,
  );
}

export function peekOldest(channelId: string): WakeupQueueRow | null {
  const row = db().prepare(
    "SELECT * FROM wakeup_queue WHERE channel_id = ? ORDER BY queued_at ASC LIMIT 1",
  ).get(channelId) as WakeupQueueRow | undefined;
  return row ?? null;
}

export function drainOldest(channelId: string): WakeupQueueRow | null {
  const row = peekOldest(channelId);
  if (!row) return null;
  db().prepare("DELETE FROM wakeup_queue WHERE id = ?").run(row.id);
  return row;
}

export function deleteByChannel(channelId: string): void {
  db().prepare("DELETE FROM wakeup_queue WHERE channel_id = ?").run(channelId);
}

export function countByChannel(channelId: string): number {
  const row = db().prepare(
    "SELECT COUNT(*) as n FROM wakeup_queue WHERE channel_id = ?",
  ).get(channelId) as { n: number };
  return row.n;
}
```

- [ ] **Step 4: Add wakeup_queue schema to initDatabase**

Modify `src/db/database.ts`. Inside `initDatabase()`'s `db.exec()` block, add the `wakeup_queue` table CREATE TABLE after the existing `sessions` table:

```sql
CREATE TABLE IF NOT EXISTS wakeup_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  dedupe_key TEXT,
  UNIQUE(channel_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_wakeup_queue_channel ON wakeup_queue(channel_id, queued_at);
```

The final `db.exec()` call should contain projects + sessions + wakeup_queue + index, all in one template literal.

- [ ] **Step 5: Re-export the row type from db/types.ts**

Add to `src/db/types.ts`:

```ts
export type { WakeupQueueRow } from "../wakeup/types.js";
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/wakeup/queue.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/wakeup/queue.ts src/wakeup/queue.test.ts src/db/database.ts src/db/types.ts
git commit -m "feat(wakeup): add wakeup_queue table and CRUD"
```

---

### Task 3: Passive Discord embed builder

**Files:**
- Create: `src/wakeup/embed.ts`
- Create: `src/wakeup/embed.test.ts`

- [ ] **Step 1: Write the failing test**

`src/wakeup/embed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPassiveEmbed } from "./embed.js";
import type { WakeupPayload } from "./types.js";

const runPlanPayload: WakeupPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status refactor-foo",
  source: "run-plan",
  metadata: { slot: "refactor-foo", status: "DONE", commits: "+7" },
  created_at: "2026-06-01T12:00:00Z",
  ttl_seconds: 86400,
};

describe("buildPassiveEmbed", () => {
  it("uses run-plan template when source is run-plan", () => {
    const embed = buildPassiveEmbed(runPlanPayload, { activeSession: false });
    const data = embed.toJSON();
    expect(data.title).toContain("run-plan");
    expect(data.title).toContain("refactor-foo");
    const blob = JSON.stringify(data);
    expect(blob).toContain("DONE");
    expect(blob).toContain("+7");
  });

  it("includes 'after current session' note when active", () => {
    const embed = buildPassiveEmbed(runPlanPayload, { activeSession: true });
    const blob = JSON.stringify(embed.toJSON());
    // Match either English or Korean copy
    expect(blob).toMatch(/current|진행/);
  });

  it("falls back to generic template for unknown source", () => {
    const generic = { ...runPlanPayload, source: "ci", metadata: { build: 42, branch: "main" } };
    const embed = buildPassiveEmbed(generic, { activeSession: false });
    const data = embed.toJSON();
    expect(data.title).toContain("ci");
    const blob = JSON.stringify(data);
    expect(blob).toContain("build");
    expect(blob).toContain("42");
  });

  it("handles missing metadata gracefully", () => {
    const noMeta = { ...runPlanPayload, source: "misc", metadata: undefined };
    const embed = buildPassiveEmbed(noMeta, { activeSession: false });
    expect(() => embed.toJSON()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wakeup/embed.test.ts`
Expected: FAIL with module-not-found for `./embed.js`.

- [ ] **Step 3: Implement embed builder**

`src/wakeup/embed.ts`:

```ts
import { EmbedBuilder } from "discord.js";
import { L } from "../utils/i18n.js";
import type { WakeupPayload } from "./types.js";

interface EmbedOptions {
  activeSession: boolean;
}

export function buildPassiveEmbed(payload: WakeupPayload, opts: EmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x2ECC71); // green — completion

  if (payload.source === "run-plan") {
    const meta = payload.metadata ?? {};
    const slot = String(meta.slot ?? "?");
    const status = String(meta.status ?? "?");
    const commits = String(meta.commits ?? "?");
    embed.setTitle(L(
      `🎯 Background task done — run-plan / ${slot}`,
      `🎯 백그라운드 작업 완료 — run-plan / ${slot}`,
    ));
    embed.addFields(
      { name: L("Status", "상태"), value: status, inline: true },
      { name: L("New commits", "새 커밋"), value: commits, inline: true },
    );
  } else {
    embed.setTitle(L(
      `🎯 Background task done — ${payload.source}`,
      `🎯 백그라운드 작업 완료 — ${payload.source}`,
    ));
    const meta = payload.metadata ?? {};
    const entries = Object.entries(meta).slice(0, 6); // bound to 6 fields
    for (const [k, v] of entries) {
      embed.addFields({ name: k, value: String(v), inline: true });
    }
  }

  if (opts.activeSession) {
    embed.setFooter({ text: L(
      "Will auto-verify after the current conversation ends",
      "현재 대화가 끝난 후 자동으로 검증합니다",
    ) });
  }

  return embed;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/wakeup/embed.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/wakeup/embed.ts src/wakeup/embed.test.ts
git commit -m "feat(wakeup): add passive Discord embed builder"
```

---

### Task 4: Legacy adapter for `/tmp/run-plan-done-*.txt`

**Files:**
- Create: `src/wakeup/legacy-adapter.ts`
- Create: `src/wakeup/legacy-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/wakeup/legacy-adapter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizePayloadFromDoneFile } from "./legacy-adapter.js";

describe("synthesizePayloadFromDoneFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-legacy-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("synthesizes a payload from a complete done+meta pair", () => {
    const doneFile = path.join(tmp, "run-plan-done-refactor-foo.txt");
    fs.writeFileSync(doneFile, [
      "slot=refactor-foo",
      "exited=2026-06-01T12:00:00",
      "commits=+7",
      "status=DONE",
    ].join("\n"));
    const metaFile = path.join(tmp, "run-plan-meta-refactor-foo.txt");
    fs.writeFileSync(metaFile, [
      "plan=/abs/path/refactor-foo.md",
      "branch=feature",
      "cwd=/abs/path",
      "started=2026-06-01T10:00:00",
      "channel_id=123456789012345678",
    ].join("\n"));

    const payload = synthesizePayloadFromDoneFile(doneFile, { metaDir: tmp });
    expect(payload).not.toBeNull();
    expect(payload!.channel_id).toBe("123456789012345678");
    expect(payload!.source).toBe("run-plan");
    expect(payload!.prompt).toBe("/run-plan status refactor-foo");
    expect(payload!.metadata).toMatchObject({
      slot: "refactor-foo",
      status: "DONE",
      commits: "+7",
    });
  });

  it("returns null when meta file is missing", () => {
    const doneFile = path.join(tmp, "run-plan-done-orphan.txt");
    fs.writeFileSync(doneFile, "slot=orphan\nstatus=DONE\n");
    expect(synthesizePayloadFromDoneFile(doneFile, { metaDir: tmp })).toBeNull();
  });

  it("returns null when meta lacks channel_id", () => {
    const doneFile = path.join(tmp, "run-plan-done-x.txt");
    fs.writeFileSync(doneFile, "slot=x\nstatus=DONE\n");
    const metaFile = path.join(tmp, "run-plan-meta-x.txt");
    fs.writeFileSync(metaFile, "plan=foo\nbranch=main\n");
    expect(synthesizePayloadFromDoneFile(doneFile, { metaDir: tmp })).toBeNull();
  });

  it("ignores files that don't match the run-plan-done pattern", () => {
    const f = path.join(tmp, "unrelated.txt");
    fs.writeFileSync(f, "hello");
    expect(synthesizePayloadFromDoneFile(f, { metaDir: tmp })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wakeup/legacy-adapter.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the adapter**

`src/wakeup/legacy-adapter.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { WakeupPayloadSchema, type WakeupPayload } from "./types.js";

interface AdapterOptions {
  /** Directory holding both done and meta files. Default: /tmp */
  metaDir?: string;
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Read /tmp/run-plan-done-<slot>.txt + its sibling meta file and produce a
 * WakeupPayload. Returns null if the file doesn't match the pattern, the meta
 * is missing, or channel_id wasn't recorded at launch (e.g., run launched
 * outside the bot).
 */
export function synthesizePayloadFromDoneFile(
  doneFilePath: string,
  opts: AdapterOptions = {},
): WakeupPayload | null {
  const base = path.basename(doneFilePath);
  const match = base.match(/^run-plan-done-(.+)\.txt$/);
  if (!match) return null;
  const slot = match[1];

  if (!fs.existsSync(doneFilePath)) return null;
  const done = parseKv(fs.readFileSync(doneFilePath, "utf-8"));

  const metaDir = opts.metaDir ?? path.dirname(doneFilePath);
  const metaPath = path.join(metaDir, `run-plan-meta-${slot}.txt`);
  if (!fs.existsSync(metaPath)) return null;
  const meta = parseKv(fs.readFileSync(metaPath, "utf-8"));

  const channelId = meta.channel_id;
  if (!channelId) return null;

  const candidate = {
    channel_id: channelId,
    prompt: `/run-plan status ${slot}`,
    source: "run-plan",
    metadata: {
      slot,
      status: done.status ?? "?",
      commits: done.commits ?? "?",
    },
    created_at: new Date().toISOString(),
  };

  const result = WakeupPayloadSchema.safeParse(candidate);
  return result.success ? result.data : null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/wakeup/legacy-adapter.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/wakeup/legacy-adapter.ts src/wakeup/legacy-adapter.test.ts
git commit -m "feat(wakeup): add legacy adapter for /tmp/run-plan-done files"
```

---

### Task 5: WakeupWatcher event dispatch (no FS yet)

**Files:**
- Create: `src/wakeup/watcher.ts`
- Create: `src/wakeup/watcher.test.ts`

This task isolates the pure `handleEvent` logic so it can be unit-tested without touching the filesystem. Task 6 layers fs.watch on top.

- [ ] **Step 1: Write the failing test**

`src/wakeup/watcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WakeupWatcher } from "./watcher.js";
import type { WakeupPayload } from "./types.js";
import Database from "better-sqlite3";
import { setQueueDb, countByChannel } from "./queue.js";

const validPayload: WakeupPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status foo",
  source: "run-plan",
  metadata: { slot: "foo", status: "DONE", commits: "+3" },
  created_at: new Date().toISOString(),
  ttl_seconds: 86400,
};

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE wakeup_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      dedupe_key TEXT,
      UNIQUE(channel_id, dedupe_key)
    );
  `);
  return db;
}

describe("WakeupWatcher.handleEvent", () => {
  let wakeUp: ReturnType<typeof vi.fn>;
  let hasActiveSession: ReturnType<typeof vi.fn>;
  let sendPassiveEmbed: ReturnType<typeof vi.fn>;
  let isChannelRegistered: ReturnType<typeof vi.fn>;
  let watcher: WakeupWatcher;

  beforeEach(() => {
    setQueueDb(freshDb());
    wakeUp = vi.fn().mockResolvedValue(undefined);
    hasActiveSession = vi.fn().mockReturnValue(false);
    sendPassiveEmbed = vi.fn().mockResolvedValue(undefined);
    isChannelRegistered = vi.fn().mockReturnValue(true);
    watcher = new WakeupWatcher({
      wakeupDir: "/dev/null",
      legacyDir: "/dev/null",
      isChannelRegistered,
      hasActiveSession,
      wakeUp,
      sendPassiveEmbed,
    });
  });

  it("calls wakeUp directly when no active session", async () => {
    await watcher.handleEvent(validPayload);
    expect(sendPassiveEmbed).toHaveBeenCalledOnce();
    expect(wakeUp).toHaveBeenCalledWith(
      validPayload.channel_id,
      validPayload.prompt,
      "run-plan",
    );
    expect(countByChannel(validPayload.channel_id)).toBe(0);
  });

  it("queues wakeup when active session exists", async () => {
    hasActiveSession.mockReturnValue(true);
    await watcher.handleEvent(validPayload);
    expect(sendPassiveEmbed).toHaveBeenCalledOnce();
    expect(wakeUp).not.toHaveBeenCalled();
    expect(countByChannel(validPayload.channel_id)).toBe(1);
  });

  it("drops events for unregistered channels (no embed, no wakeup)", async () => {
    isChannelRegistered.mockReturnValue(false);
    await watcher.handleEvent(validPayload);
    expect(sendPassiveEmbed).not.toHaveBeenCalled();
    expect(wakeUp).not.toHaveBeenCalled();
    expect(countByChannel(validPayload.channel_id)).toBe(0);
  });

  it("drops expired events", async () => {
    const expired = {
      ...validPayload,
      created_at: new Date(Date.now() - 200_000).toISOString(),
      ttl_seconds: 60,
    };
    await watcher.handleEvent(expired);
    expect(sendPassiveEmbed).not.toHaveBeenCalled();
    expect(wakeUp).not.toHaveBeenCalled();
  });

  it("dedupes when same slot queued twice during active session", async () => {
    hasActiveSession.mockReturnValue(true);
    await watcher.handleEvent(validPayload);
    await watcher.handleEvent({ ...validPayload, prompt: "/run-plan status foo updated" });
    expect(countByChannel(validPayload.channel_id)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wakeup/watcher.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement WakeupWatcher (dispatch only — fs.watch in Task 6)**

`src/wakeup/watcher.ts`:

```ts
import { EmbedBuilder } from "discord.js";
import { WakeupPayloadSchema, isExpired, type WakeupPayload } from "./types.js";
import { enqueueWakeup } from "./queue.js";
import { buildPassiveEmbed } from "./embed.js";

export interface WakeupWatcherDeps {
  /** Absolute path to the generic wake-up JSON drop directory. */
  wakeupDir: string;
  /** Absolute path watched for legacy run-plan-done files (typically "/tmp"). */
  legacyDir: string;
  /** Returns true if `channelId` is a registered project. */
  isChannelRegistered: (channelId: string) => boolean;
  /** Returns true if a Claude session is currently running in `channelId`. */
  hasActiveSession: (channelId: string) => boolean;
  /** Spawn a new Claude session for `channelId` with `prompt`. */
  wakeUp: (channelId: string, prompt: string, source: string) => Promise<void>;
  /** Send the passive notification embed to `channelId`. */
  sendPassiveEmbed: (channelId: string, embed: EmbedBuilder) => Promise<void>;
}

export class WakeupWatcher {
  constructor(private readonly deps: WakeupWatcherDeps) {}

  /**
   * Dispatch a validated payload. Pure with respect to the filesystem —
   * callers are responsible for parsing/validating the JSON and calling
   * this with a typed object.
   */
  async handleEvent(payload: WakeupPayload): Promise<void> {
    if (!this.deps.isChannelRegistered(payload.channel_id)) {
      console.warn(
        `[wakeup] dropping event for unregistered channel ${payload.channel_id} (source=${payload.source})`,
      );
      return;
    }

    if (isExpired(payload)) {
      console.warn(
        `[wakeup] dropping expired event for channel ${payload.channel_id} (created_at=${payload.created_at}, ttl=${payload.ttl_seconds}s)`,
      );
      return;
    }

    const active = this.deps.hasActiveSession(payload.channel_id);

    try {
      const embed = buildPassiveEmbed(payload, { activeSession: active });
      await this.deps.sendPassiveEmbed(payload.channel_id, embed);
    } catch (e) {
      // Embed failure shouldn't block the wakeup itself — log and continue.
      console.warn(
        `[wakeup] passive embed failed for ${payload.channel_id}:`,
        e instanceof Error ? e.message : e,
      );
    }

    if (active) {
      enqueueWakeup(payload);
      console.log(
        `[wakeup] queued for channel ${payload.channel_id} (source=${payload.source}) — session active`,
      );
    } else {
      try {
        await this.deps.wakeUp(payload.channel_id, payload.prompt, payload.source);
      } catch (e) {
        console.error(
          `[wakeup] wakeUp() failed for ${payload.channel_id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  // start() / stop() / file parsing arrive in Task 6.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async start(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async stop(): Promise<void> {}

  /** Exposed only so the schema can be re-parsed by callers without circular imports. */
  static schema = WakeupPayloadSchema;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/wakeup/watcher.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/wakeup/watcher.ts src/wakeup/watcher.test.ts
git commit -m "feat(wakeup): add WakeupWatcher event dispatch"
```

---

### Task 6: WakeupWatcher filesystem integration

**Files:**
- Modify: `src/wakeup/watcher.ts` (replace empty `start()` / `stop()` with real fs.watch + scan)
- Modify: `src/wakeup/watcher.test.ts` (add FS integration tests)

- [ ] **Step 1: Write the failing test**

Append to `src/wakeup/watcher.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("WakeupWatcher filesystem integration", () => {
  let wakeupDir: string;
  let legacyDir: string;
  let watcher: WakeupWatcher;
  let wakeUp: ReturnType<typeof vi.fn>;
  let sendPassiveEmbed: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setQueueDb(freshDb());
    wakeupDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-dir-"));
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-legacy-"));
    wakeUp = vi.fn().mockResolvedValue(undefined);
    sendPassiveEmbed = vi.fn().mockResolvedValue(undefined);
    watcher = new WakeupWatcher({
      wakeupDir,
      legacyDir,
      isChannelRegistered: () => true,
      hasActiveSession: () => false,
      wakeUp,
      sendPassiveEmbed,
    });
    await watcher.start();
  });

  afterEach(async () => {
    await watcher.stop();
    fs.rmSync(wakeupDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  it("startup scan picks up files dropped before start()", async () => {
    await watcher.stop();
    const payload = {
      channel_id: "123456789012345678",
      prompt: "/x",
      source: "test",
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(wakeupDir, "pre-existing.json"), JSON.stringify(payload));
    await watcher.start();
    // Drain microtasks
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).toHaveBeenCalledWith("123456789012345678", "/x", "test");
    // File got cleaned up
    expect(fs.existsSync(path.join(wakeupDir, "pre-existing.json"))).toBe(false);
  });

  it("moves malformed JSON to .rejected/ subdir", async () => {
    await watcher.stop();
    fs.writeFileSync(path.join(wakeupDir, "bad.json"), "{ not json");
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(wakeupDir, ".rejected", "bad.json"))).toBe(true);
  });

  it("ignores files lacking .json extension", async () => {
    await watcher.stop();
    fs.writeFileSync(path.join(wakeupDir, "temp.tmp"), "ignored");
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(wakeupDir, "temp.tmp"))).toBe(true);
  });

  it("synthesizes payload from legacy /tmp/run-plan-done file", async () => {
    await watcher.stop();
    fs.writeFileSync(
      path.join(legacyDir, "run-plan-done-foo.txt"),
      "slot=foo\nstatus=DONE\ncommits=+2\n",
    );
    fs.writeFileSync(
      path.join(legacyDir, "run-plan-meta-foo.txt"),
      "plan=/p\nbranch=main\nchannel_id=123456789012345678\n",
    );
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).toHaveBeenCalledWith(
      "123456789012345678",
      "/run-plan status foo",
      "run-plan",
    );
    // Legacy done file is NOT deleted (skill owns that state)
    expect(fs.existsSync(path.join(legacyDir, "run-plan-done-foo.txt"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wakeup/watcher.test.ts`
Expected: 4 new tests FAIL (existing 5 still pass).

- [ ] **Step 3: Implement fs.watch + startup scan**

Rewrite the end of `src/wakeup/watcher.ts` (replace the empty `start()` / `stop()` from Task 5):

```ts
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { synthesizePayloadFromDoneFile } from "./legacy-adapter.js";

// ... (keep handleEvent and constructor unchanged) ...

  private wakeupWatcher: fs.FSWatcher | null = null;
  private legacyWatcher: fs.FSWatcher | null = null;
  // Track in-flight processing to avoid double-handling when fs.watch fires
  // both rename + change for the same file on macOS/Windows.
  private inflight = new Set<string>();

  async start(): Promise<void> {
    await fsp.mkdir(this.deps.wakeupDir, { recursive: true });
    // Best-effort chmod 700 — fails silently on filesystems that don't support it (e.g., Windows FAT)
    try {
      await fsp.chmod(this.deps.wakeupDir, 0o700);
    } catch {
      // ignore
    }
    await fsp.mkdir(path.join(this.deps.wakeupDir, ".rejected"), { recursive: true });

    await this.scanWakeupDir();
    await this.scanLegacyDir();

    this.wakeupWatcher = fs.watch(this.deps.wakeupDir, (_event, filename) => {
      if (!filename) return;
      this.processWakeupFile(path.join(this.deps.wakeupDir, filename)).catch((e) => {
        console.warn(`[wakeup] processing ${filename} failed:`, e instanceof Error ? e.message : e);
      });
    });

    if (fs.existsSync(this.deps.legacyDir)) {
      this.legacyWatcher = fs.watch(this.deps.legacyDir, (_event, filename) => {
        if (!filename) return;
        const base = path.basename(filename);
        if (!base.startsWith("run-plan-done-") || !base.endsWith(".txt")) return;
        this.processLegacyFile(path.join(this.deps.legacyDir, base)).catch((e) => {
          console.warn(`[wakeup] legacy processing ${base} failed:`, e instanceof Error ? e.message : e);
        });
      });
    }
  }

  async stop(): Promise<void> {
    this.wakeupWatcher?.close();
    this.legacyWatcher?.close();
    this.wakeupWatcher = null;
    this.legacyWatcher = null;
  }

  private async scanWakeupDir(): Promise<void> {
    if (!fs.existsSync(this.deps.wakeupDir)) return;
    const entries = await fsp.readdir(this.deps.wakeupDir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      await this.processWakeupFile(path.join(this.deps.wakeupDir, name));
    }
  }

  private async scanLegacyDir(): Promise<void> {
    if (!fs.existsSync(this.deps.legacyDir)) return;
    const entries = await fsp.readdir(this.deps.legacyDir);
    for (const name of entries) {
      if (!name.startsWith("run-plan-done-") || !name.endsWith(".txt")) continue;
      await this.processLegacyFile(path.join(this.deps.legacyDir, name));
    }
  }

  private async processWakeupFile(filePath: string): Promise<void> {
    if (!filePath.endsWith(".json")) return;
    if (this.inflight.has(filePath)) return;
    this.inflight.add(filePath);
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = await fsp.readFile(filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await this.rejectFile(filePath, "invalid JSON");
        return;
      }
      const result = WakeupPayloadSchema.safeParse(parsed);
      if (!result.success) {
        await this.rejectFile(filePath, `schema violation: ${result.error.issues.map((i) => i.message).join("; ")}`);
        return;
      }
      await this.handleEvent(result.data);
      // Success → delete the trigger file
      await fsp.unlink(filePath).catch(() => {});
    } finally {
      this.inflight.delete(filePath);
    }
  }

  private async processLegacyFile(filePath: string): Promise<void> {
    if (this.inflight.has(filePath)) return;
    this.inflight.add(filePath);
    try {
      if (!fs.existsSync(filePath)) return;
      const payload = synthesizePayloadFromDoneFile(filePath, { metaDir: this.deps.legacyDir });
      if (!payload) {
        console.warn(`[wakeup] legacy adapter could not synthesize payload from ${filePath}`);
        return;
      }
      await this.handleEvent(payload);
      // NOTE: do NOT delete the legacy done file — skill owns that state
    } finally {
      this.inflight.delete(filePath);
    }
  }

  private async rejectFile(filePath: string, reason: string): Promise<void> {
    const dest = path.join(this.deps.wakeupDir, ".rejected", path.basename(filePath));
    try {
      await fsp.rename(filePath, dest);
      console.warn(`[wakeup] rejected ${path.basename(filePath)}: ${reason}`);
    } catch (e) {
      console.warn(`[wakeup] failed to move rejected file:`, e instanceof Error ? e.message : e);
    }
  }
```

Drop the `eslint-disable` placeholders from Task 5 and the `static schema = ...` (no longer needed since the watcher imports the schema directly).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/wakeup/watcher.test.ts`
Expected: all 9 tests pass (5 dispatch + 4 fs).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/wakeup/watcher.ts src/wakeup/watcher.test.ts
git commit -m "feat(wakeup): add filesystem watch + startup scan + legacy adapter wiring"
```

---

### Task 7: `WAKEUP_DIR_OVERRIDE` env + path resolution helper

**Files:**
- Modify: `src/utils/config.ts` (add the optional env)
- Create: `src/wakeup/paths.ts` (resolves wake-up dir from config / homedir)
- Create: `src/wakeup/paths.test.ts`

- [ ] **Step 1: Add the env to config schema**

Modify `src/utils/config.ts`. Inside `envSchema`, add (after the existing fields, before the closing brace):

```ts
  // Override the default ~/.claudecode-discord/wakeups path. Test hook —
  // production deployments should leave this unset.
  WAKEUP_DIR_OVERRIDE: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
```

- [ ] **Step 2: Write the failing test**

`src/wakeup/paths.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => "/home/test" },
    homedir: () => "/home/test",
  };
});

import { getConfig } from "../utils/config.js";
import { resolveWakeupDir } from "./paths.js";

describe("resolveWakeupDir", () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset();
  });

  it("uses ~/.claudecode-discord/wakeups by default", () => {
    vi.mocked(getConfig).mockReturnValue({ WAKEUP_DIR_OVERRIDE: undefined } as ReturnType<typeof getConfig>);
    expect(resolveWakeupDir()).toBe("/home/test/.claudecode-discord/wakeups");
  });

  it("honors WAKEUP_DIR_OVERRIDE when set", () => {
    vi.mocked(getConfig).mockReturnValue({ WAKEUP_DIR_OVERRIDE: "/custom/dir" } as ReturnType<typeof getConfig>);
    expect(resolveWakeupDir()).toBe("/custom/dir");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/wakeup/paths.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement the resolver**

`src/wakeup/paths.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { getConfig } from "../utils/config.js";

/**
 * Absolute path to the wake-up drop directory. Honors WAKEUP_DIR_OVERRIDE
 * for tests, otherwise resolves to ~/.claudecode-discord/wakeups.
 */
export function resolveWakeupDir(): string {
  const override = getConfig().WAKEUP_DIR_OVERRIDE;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".claudecode-discord", "wakeups");
}
```

- [ ] **Step 5: Run tests + type-check**

Run: `npx vitest run src/wakeup/paths.test.ts && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/config.ts src/wakeup/paths.ts src/wakeup/paths.test.ts
git commit -m "feat(wakeup): add WAKEUP_DIR_OVERRIDE config + path resolver"
```

---

### Task 8: `SessionManager.wakeUp()` + env var injection

**Files:**
- Modify: `src/claude/session-manager.ts`
- Modify: `src/claude/session-manager.test.ts`

This task does **two** related changes on `SessionManager`: (a) add the `wakeUp(channelId, prompt, source)` method, (b) inject `WAKEUP_CHANNEL_ID` + `WAKEUP_DIR` into the env passed to `query()`.

- [ ] **Step 1: Write the failing test (wakeUp method)**

Append to `src/claude/session-manager.test.ts`:

```ts
import { sessionManager } from "./session-manager.js";

describe("SessionManager.wakeUp", () => {
  it("delegates to sendMessage with the synthesized prompt", async () => {
    const calls: { channelId: string; prompt: string }[] = [];
    // @ts-expect-error - overriding internal method for test
    sessionManager.sendMessage = async (channel: { id: string }, prompt: string) => {
      calls.push({ channelId: channel.id, prompt });
    };
    // @ts-expect-error - minimal channel stub
    await sessionManager.wakeUp({ id: "123456789012345678" }, "/run-plan status foo", "run-plan");
    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe("123456789012345678");
    // Prompt should include a Discord channel-context tag so /run-plan Step 7
    // routes to Discord reply rather than PushNotification.
    expect(calls[0].prompt).toContain("<channel source=\"discord\"");
    expect(calls[0].prompt).toContain("chat_id=\"123456789012345678\"");
    expect(calls[0].prompt).toContain("/run-plan status foo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/claude/session-manager.test.ts -t "SessionManager.wakeUp"`
Expected: FAIL — `sessionManager.wakeUp` is not a function.

- [ ] **Step 3: Add wakeUp method to SessionManager**

In `src/claude/session-manager.ts`, locate the `SessionManager` class. After the `sendMessage()` method definition (before `stopSession`), add:

```ts
  /**
   * Spawn a Claude session for an externally-triggered wake-up event
   * (e.g., codex finishing in the background). The synthesized prompt is
   * tagged with a Discord channel-context preamble so any skill that
   * scans conversation history (notably /run-plan Step 7) routes its
   * completion reply back to this Discord channel.
   */
  async wakeUp(
    channel: TextChannel,
    prompt: string,
    source: string,
  ): Promise<void> {
    const preamble =
      `<channel source="discord" chat_id="${channel.id}" user="wakeup:${source}" ts="${new Date().toISOString()}">\n` +
      `wakeup-prompt source=${source}\n` +
      `</channel>\n\n`;
    await this.sendMessage(channel, preamble + prompt);
  }
```

(Imports of `TextChannel` already present at top of file.)

- [ ] **Step 4: Run test — wakeUp should pass**

Run: `npx vitest run src/claude/session-manager.test.ts -t "SessionManager.wakeUp"`
Expected: PASS.

- [ ] **Step 5: Inject WAKEUP env vars into query()**

In `src/claude/session-manager.ts`, locate the `runQuery` function (the `query({...})` call inside `sendMessage`). The current `env:` line reads:

```ts
env: { ...process.env, ANTHROPIC_API_KEY: undefined, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
```

Replace it with:

```ts
env: {
  ...process.env,
  ANTHROPIC_API_KEY: undefined,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  WAKEUP_CHANNEL_ID: channel.id,
  WAKEUP_DIR: resolveWakeupDir(),
},
```

Add the import at the top of the file (next to the other `./` imports):

```ts
import { resolveWakeupDir } from "../wakeup/paths.js";
```

- [ ] **Step 6: Write the failing test (env injection)**

The existing `src/claude/session-manager.test.ts` already mocks `@anthropic-ai/claude-agent-sdk` with `vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }))` and imports `sessionManager`. Add this `vi.mock` line at the top alongside the existing mocks (after the existing `vi.mock("../utils/config.js", ...)`):

```ts
vi.mock("../wakeup/paths.js", () => ({
  resolveWakeupDir: vi.fn(() => "/tmp/test-wakeup-dir"),
}));
```

Then append this test block to the file:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getProject as getProjectMock } from "../db/database.js";

describe("query env injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectMock).mockReturnValue({
      channel_id: "123456789012345678",
      project_path: "/tmp/project",
      guild_id: "g",
      auto_approve: 0,
      source_path: null,
      created_at: "",
    });
    // query() yields nothing then returns — sendMessage will see hasResult=false
    // and exit cleanly through the existing error path. We don't care about the
    // result for this test; we only care that env was passed.
    vi.mocked(query).mockImplementation((() => {
      const gen = (async function* () {
        return;
      })();
      return Object.assign(gen, { interrupt: async () => {} });
    }) as unknown as typeof query);
  });

  it("injects WAKEUP_CHANNEL_ID and WAKEUP_DIR into query env", async () => {
    const channel = mockChannel("123456789012345678");
    await sessionManager.sendMessage(channel, "hello").catch(() => {}); // ignore error path
    expect(query).toHaveBeenCalled();
    const opts = vi.mocked(query).mock.calls.at(-1)![0] as {
      options: { env: Record<string, string | undefined> };
    };
    expect(opts.options.env.WAKEUP_CHANNEL_ID).toBe("123456789012345678");
    expect(opts.options.env.WAKEUP_DIR).toBe("/tmp/test-wakeup-dir");
  });
});
```

- [ ] **Step 7: Run all session-manager tests**

Run: `npx vitest run src/claude/session-manager.test.ts`
Expected: all tests pass (existing + new).

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/claude/session-manager.ts src/claude/session-manager.test.ts
git commit -m "feat(wakeup): add SessionManager.wakeUp + inject WAKEUP env vars"
```

---

### Task 9: Drain `wakeup_queue` in `sendMessage` finally

**Files:**
- Modify: `src/claude/session-manager.ts` (finally block)
- Modify: `src/claude/session-manager.test.ts` (new test case)

- [ ] **Step 1: Write the failing test**

Append to `src/claude/session-manager.test.ts`. Reuses the mocks set up by Task 8 (config, db/database, SDK, paths). Add a mock for the wakeup queue at the top of the file:

```ts
vi.mock("../wakeup/queue.js", () => ({
  drainOldest: vi.fn(),
}));
```

Then append:

```ts
import { drainOldest } from "../wakeup/queue.js";

describe("sendMessage finally — wakeup queue drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectMock).mockReturnValue({
      channel_id: "123456789012345678",
      project_path: "/tmp/project",
      guild_id: "g",
      auto_approve: 0,
      source_path: null,
      created_at: "",
    });
    vi.mocked(query).mockImplementation((() => {
      const gen = (async function* () { return; })();
      return Object.assign(gen, { interrupt: async () => {} });
    }) as unknown as typeof query);
  });

  it("calls wakeUp with queued payload when no in-memory messageQueue exists", async () => {
    const queuedPayload = {
      channel_id: "123456789012345678",
      prompt: "/run-plan status foo",
      source: "run-plan",
      metadata: { slot: "foo" },
      created_at: new Date().toISOString(),
      ttl_seconds: 86400,
    };
    vi.mocked(drainOldest).mockReturnValueOnce({
      id: 1,
      channel_id: "123456789012345678",
      source: "run-plan",
      payload_json: JSON.stringify(queuedPayload),
      queued_at: Date.now(),
      dedupe_key: "run-plan:foo",
    });

    const wakeUpSpy = vi.spyOn(sessionManager, "wakeUp").mockResolvedValue(undefined);
    const channel = mockChannel("123456789012345678");
    await sessionManager.sendMessage(channel, "hello").catch(() => {});

    expect(drainOldest).toHaveBeenCalledWith("123456789012345678");
    expect(wakeUpSpy).toHaveBeenCalledWith(channel, queuedPayload.prompt, "run-plan");
    wakeUpSpy.mockRestore();
  });

  it("does not check wakeup_queue when in-memory messageQueue has items", async () => {
    const channel = mockChannel("123456789012345678");
    // Prime the in-memory queue via a public seam: enqueue a fake follow-up
    // by calling sendMessage twice in flight. The simpler check: after a
    // single run where no queue entry exists, drainOldest is called once.
    // When messageQueue has items, drainOldest should NOT be called.
    // For this test, simulate the in-memory queue path by stuffing
    // sessionManager["messageQueue"] directly:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessionManager as any).messageQueue.set("123456789012345678", [
      { channel, prompt: "next user msg" },
    ]);

    const wakeUpSpy = vi.spyOn(sessionManager, "wakeUp").mockResolvedValue(undefined);
    // sendMessage is called recursively in the finally for the queued item;
    // mock it after first call to avoid infinite recursion:
    const realSend = sessionManager.sendMessage.bind(sessionManager);
    let callCount = 0;
    const sendSpy = vi.spyOn(sessionManager, "sendMessage").mockImplementation(async (c, p) => {
      callCount++;
      if (callCount === 1) return realSend(c, p);
      // second call (the recursive one for "next user msg") — no-op
      return;
    });

    await realSend(channel, "first").catch(() => {});

    expect(drainOldest).not.toHaveBeenCalled();
    expect(wakeUpSpy).not.toHaveBeenCalled();

    sendSpy.mockRestore();
    wakeUpSpy.mockRestore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessionManager as any).messageQueue.clear();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/claude/session-manager.test.ts -t "wakeup queue drain"`
Expected: FAIL — `drainOldest` not yet called from session-manager.

- [ ] **Step 3: Implement drain in finally block**

In `src/claude/session-manager.ts`, locate the existing finally block (around line 703-748, ends after `// Process next queued message if any`). After the existing message queue block (the one that calls `this.sendMessage(next.channel, next.prompt)`), add a sibling block:

```ts
      // After in-memory messageQueue is drained (or if it was empty),
      // check the persistent wakeup_queue. This is the recovery path for
      // background tasks that asked to wake Claude up while a session
      // was active.
      if (!queue || queue.length === 0) {
        const wakeupRow = drainOldest(channelId);
        if (wakeupRow) {
          try {
            const payload = WakeupPayloadSchema.parse(JSON.parse(wakeupRow.payload_json));
            const preview = payload.prompt.length > 40
              ? payload.prompt.slice(0, 40) + "…"
              : payload.prompt;
            channel.send(L(
              `🎯 Processing queued wakeup from ${payload.source}...\n> ${preview}`,
              `🎯 대기 중이던 wakeup을 처리합니다 (${payload.source})...\n> ${preview}`,
            )).catch(() => {});
            this.wakeUp(channel, payload.prompt, payload.source).catch((err) => {
              console.error("Queue wakeUp error:", err);
            });
          } catch (e) {
            console.warn(
              `[wakeup] dropping malformed queue row id=${wakeupRow.id}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }
      }
```

Add imports near the top of the file:

```ts
import { drainOldest } from "../wakeup/queue.js";
import { WakeupPayloadSchema } from "../wakeup/types.js";
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/claude/session-manager.test.ts`
Expected: all tests pass including the new drain tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude/session-manager.ts src/claude/session-manager.test.ts
git commit -m "feat(wakeup): drain wakeup_queue when session ends"
```

---

### Task 10: Wire up WakeupWatcher in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read the current index.ts**

Re-read `src/index.ts` to understand the `main()` flow. The watcher must start AFTER `initDatabase()` (it depends on the DB connection via `getDb()`) and AFTER `startBot()` (it needs the Discord client to send embeds).

- [ ] **Step 2: Add the wiring**

Modify `src/index.ts`:

1. Add imports at the top, beside the existing ones:

```ts
import { WakeupWatcher } from "./claude/wake-watcher-bootstrap.js";
```

Wait — we don't have that file. Instead, we'll create a thin bootstrap function in `src/claude/` that has access to the SessionManager singleton + Discord client. Add the import:

```ts
import { startWakeupWatcher } from "./wakeup/bootstrap.js";
```

2. Inside `main()`, after `await startBot();` and before `console.log("Bot is running!");`, add:

```ts
  await startWakeupWatcher();
  console.log("Wake-up watcher started");
```

- [ ] **Step 3: Expose the Discord client at module level**

`sessionManager.isActive` already exists in `src/claude/session-manager.ts` (line ~791). Verify with:

```bash
grep -n "isActive" src/claude/session-manager.ts
```

Expected: a line showing `isActive(channelId: string): boolean`. Good — no change needed.

However, `bot/client.ts` keeps the Discord `Client` instance local to `startBot()`. We need module-level access. Add to `src/bot/client.ts`:

Near the existing top-level exports (around line 38-43, beside `botOwnedCommandNames` and `commandMap`), add:

```ts
let _discordClient: Client | null = null;
export function getDiscordClient(): Client {
  if (!_discordClient) throw new Error("Discord client not initialized — call startBot() first");
  return _discordClient;
}
```

Then in `startBot()`, immediately after `const client = new Client({ ... });`, add:

```ts
  _discordClient = client;
```

- [ ] **Step 4: Create the bootstrap**

`src/wakeup/bootstrap.ts`:

```ts
import { resolveWakeupDir } from "./paths.js";
import { WakeupWatcher } from "./watcher.js";
import { sessionManager } from "../claude/session-manager.js";
import { getProject } from "../db/database.js";
import { getDiscordClient } from "../bot/client.js";
import type { TextChannel, EmbedBuilder } from "discord.js";

let watcher: WakeupWatcher | null = null;

export async function startWakeupWatcher(): Promise<void> {
  if (watcher) return;
  const client = getDiscordClient();

  watcher = new WakeupWatcher({
    wakeupDir: resolveWakeupDir(),
    legacyDir: "/tmp",

    isChannelRegistered: (channelId) => Boolean(getProject(channelId)),
    hasActiveSession: (channelId) => sessionManager.isActive(channelId),

    wakeUp: async (channelId, prompt, source) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[wakeup] channel ${channelId} not fetchable`);
        return;
      }
      await sessionManager.wakeUp(channel as TextChannel, prompt, source);
    },

    sendPassiveEmbed: async (channelId, embed: EmbedBuilder) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      await (channel as TextChannel).send({ embeds: [embed] });
    },
  });

  await watcher.start();
}

export async function stopWakeupWatcher(): Promise<void> {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}
```

- [ ] **Step 5: Hook up SIGINT/SIGTERM cleanup**

In `src/index.ts`, the existing signal handlers look like:

```ts
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
```

Replace them with:

```ts
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

Import `stopWakeupWatcher` from `./wakeup/bootstrap.js`.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If errors appear about missing `getDiscordClient`, re-check Step 3.

- [ ] **Step 7: Smoke test**

Run: `npm run dev`

Expected log lines:
```
Database initialized
Bot is running!
Wake-up watcher started
```

In another shell, drop a test payload:

```bash
mkdir -p ~/.claudecode-discord/wakeups
cat > ~/.claudecode-discord/wakeups/test.json << 'EOF'
{
  "channel_id": "<REPLACE_WITH_REGISTERED_CHANNEL_ID>",
  "prompt": "echo: wakeup smoke test",
  "source": "smoke-test",
  "created_at": "<run: date -u +%Y-%m-%dT%H:%M:%SZ>"
}
EOF
```

Expected:
- File disappears from `~/.claudecode-discord/wakeups/` within ~1 sec
- Discord channel shows a passive embed
- Claude session spawns and responds to "echo: wakeup smoke test"

Stop the bot (Ctrl-C) before committing.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/wakeup/bootstrap.ts src/claude/session-manager.ts src/bot/client.ts
git commit -m "feat(wakeup): boot WakeupWatcher in main; expose isActive + getDiscordClient"
```

---

### Task 11: Update `/run-plan` skill (heartbeat tail + meta channel_id)

**Files:**
- Modify: `~/.claude/skills/run-plan/SKILL.md`

This file lives outside the project repo (user-global skill). Changes are isolated to two locations.

- [ ] **Step 1: Re-read the skill file**

Run: `cat ~/.claude/skills/run-plan/SKILL.md | sed -n '230,270p'`

Locate the Step 3 META_FILE write block and the Step 4 heartbeat watcher tail.

- [ ] **Step 2: Add channel_id to META_FILE in Step 3**

In `~/.claude/skills/run-plan/SKILL.md`, find the block (around line 239-244):

```bash
{
  echo "plan=$PLAN_ABS"
  echo "branch=$BRANCH"
  echo "cwd=$CWD"
  echo "started=$(date +%Y-%m-%dT%H:%M:%S)"
} > "$META_FILE"
```

Replace with:

```bash
{
  echo "plan=$PLAN_ABS"
  echo "branch=$BRANCH"
  echo "cwd=$CWD"
  echo "started=$(date +%Y-%m-%dT%H:%M:%S)"
  echo "channel_id=${WAKEUP_CHANNEL_ID:-}"
} > "$META_FILE"
```

- [ ] **Step 3: Write wakeup JSON at end of heartbeat watcher**

Find the heartbeat watcher Step 4 block. After the `echo "$FINAL_STATUS" > "$DONE_FILE"` write (around line 340) and BEFORE the OS notification block, add:

```bash
# claudecode-discord wake-up channel — write a JSON drop so the bot can
# re-invoke a Claude session in the right Discord channel. No-op outside
# claudecode-discord (env vars unset).
if [ -n "$WAKEUP_CHANNEL_ID" ] && [ -n "$WAKEUP_DIR" ] && [ -d "$WAKEUP_DIR" ]; then
  WAKEUP_UUID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$(date +%s)-$$")
  WAKEUP_FILE="$WAKEUP_DIR/$WAKEUP_UUID.json"
  cat > "$WAKEUP_FILE.tmp" << WAKEUP_JSON_END
{
  "channel_id": "$WAKEUP_CHANNEL_ID",
  "prompt": "/run-plan status $SLOT",
  "source": "run-plan",
  "metadata": {"slot": "$SLOT", "status": "$FINAL_STATUS", "commits": "+$FINAL_COMMITS"},
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
WAKEUP_JSON_END
  mv "$WAKEUP_FILE.tmp" "$WAKEUP_FILE"
fi
```

- [ ] **Step 4: Verify the bash syntax**

Run: `bash -n ~/.claude/skills/run-plan/SKILL.md` — this will fail (it's markdown, not bash). Instead, extract just the bash blocks and check:

```bash
awk '/^```bash$/,/^```$/' ~/.claude/skills/run-plan/SKILL.md | grep -v '^```' > /tmp/run-plan-bash-check.sh
bash -n /tmp/run-plan-bash-check.sh
```

Expected: no syntax errors (or only errors from unrelated unresolved variables, which are runtime concerns).

- [ ] **Step 5: Document in the skill's introduction**

At the top of `~/.claude/skills/run-plan/SKILL.md`, in the bullet list under "Wraps `codex exec` to run a written implementation plan end-to-end without hand-holding", add a new bullet:

```markdown
- When `WAKEUP_CHANNEL_ID` + `WAKEUP_DIR` env vars are set (claudecode-discord
  injects these), the heartbeat watcher also drops a wake-up JSON so the
  Discord bot can re-invoke Claude in the originating channel.
```

- [ ] **Step 6: No commit for this file**

The skill file lives outside the project repo. Note the change in the project commit log only:

```bash
cd ~/Desktop/code/claudecode-discord
git commit --allow-empty -m "docs: note /run-plan skill update for wake-up channel

Skill file at ~/.claude/skills/run-plan/SKILL.md was updated to:
- Write channel_id to /tmp/run-plan-meta-*.txt (Step 3)
- Drop a wake-up JSON in \$WAKEUP_DIR after codex exit (Step 4)

The skill file is user-global, not in this repo."
```

---

### Task 12: End-to-end happy path verification

**Files:**
- None (verification only)

- [ ] **Step 1: Start the bot**

Run: `npm run dev`

Expected log lines: `Database initialized`, `Bot is running!`, `Wake-up watcher started`.

- [ ] **Step 2: Register a test channel**

In Discord, run `/register <project-path>` in a test channel. Note the channel ID.

- [ ] **Step 3: Trigger a tiny /run-plan via Discord**

In the same channel, send: `/run-plan` (or `跑 plan`). Pick a very small plan (or write a 1-task throwaway plan).

- [ ] **Step 4: Wait for codex to finish**

Watch the bot logs for `[wakeup]` entries. The codex run typically takes 1-2 min for a 1-task plan.

- [ ] **Step 5: Verify Discord behavior**

Expected:
1. Passive embed appears: "🎯 Background task done — run-plan / <slot>"
2. If no other session is active, a NEW Claude session spawns with the prompt `/run-plan status <slot>` (visible as a normal `⏳ Thinking...` message followed by streaming response)
3. Claude posts the Step 7 verification summary to the channel

- [ ] **Step 6: Verify queue path**

While codex is still running, send a normal message to the bot to start a Claude session. When codex finishes, expected:
1. Passive embed appears immediately
2. Embed footer mentions "auto-verify after current conversation ends"
3. Once the user-initiated session ends, the queued wakeup fires automatically
4. `wakeup_queue` table is empty afterward (verify via `sqlite3 data.db "select * from wakeup_queue"`)

- [ ] **Step 7: Smoke test the legacy adapter**

Stop the bot. Without re-starting, drop a fake done+meta pair:

```bash
slot="legacy-test"
cat > /tmp/run-plan-done-$slot.txt << 'EOF'
slot=legacy-test
exited=2026-06-01T15:00:00
commits=+0
status=DONE
EOF
cat > /tmp/run-plan-meta-$slot.txt << EOF
plan=/fake
branch=main
cwd=/fake
started=2026-06-01T14:00:00
channel_id=<REPLACE_WITH_REGISTERED_CHANNEL_ID>
EOF
```

Restart the bot (`npm run dev`). Expected:
1. Startup scan picks up the legacy file
2. Discord channel receives passive embed + a Claude session running `/run-plan status legacy-test`
3. `/tmp/run-plan-done-legacy-test.txt` is NOT deleted by the bot (only the skill's Step 7 clears it)

- [ ] **Step 8: Smoke test rejected file path**

```bash
echo "{ not json" > ~/.claudecode-discord/wakeups/bad.json
```

Expected within ~1s:
- File moves to `~/.claudecode-discord/wakeups/.rejected/bad.json`
- Bot log warns "rejected bad.json: invalid JSON"

- [ ] **Step 9: Clean up + commit verification notes**

Remove test artifacts:

```bash
rm -f /tmp/run-plan-done-legacy-test.txt /tmp/run-plan-meta-legacy-test.txt
rm -rf ~/.claudecode-discord/wakeups/.rejected
```

If anything failed, **stop and fix before commit**. If everything passes:

```bash
git commit --allow-empty -m "test: verify wake-up channel end-to-end happy path

Verified:
- Idle-channel wakeup spawns Claude session + Discord reply
- Active-session wakeup → passive embed + queue drain on session end
- Legacy /tmp/run-plan-done file adapter works (startup scan)
- Malformed JSON moves to .rejected/"
```

---

## Self-review checklist (for the implementer)

Before considering this plan done, verify:

- [ ] All 12 tasks completed in order
- [ ] `npx vitest run` — all tests green
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npm run build` succeeds
- [ ] AC-001 through AC-007 from the spec all verified by Task 12
- [ ] No `TODO` / `TBD` left in code
- [ ] `data.db` migration is safe: re-running `initDatabase()` on an old DB succeeds (the `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` handle this)

## Execution log

2026-06-01:
- Tasks 1-11 completed in order and committed.
- Task 12 automated checks passed:
  - `npx vitest run` — 22 files, 312 tests passed.
  - `npx tsc --noEmit` — passed.
  - `npm run build` — passed.
  - `rg -n "TODO|TBD" src docs/superpowers/plans/2026-06-01-wakeup-channel.md ~/.claude/skills/run-plan/SKILL.md` found only this plan checklist text, not code TODO/TBD.
- Task 10/12 live dev smoke is blocked by an existing bot instance: `npm run dev` exited with `Another bot instance is already running. Exiting.`
- Task 12 Discord end-to-end checks were not run because they require a live Discord channel registration and replacing/stopping the already-running bot instance. No Task 12 verification commit was created.
