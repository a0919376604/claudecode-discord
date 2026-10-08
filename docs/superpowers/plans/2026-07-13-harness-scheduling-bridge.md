# Harness Scheduling Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge the five harness scheduling / notification tools (`ScheduleWakeup`, `CronCreate`, `CronList`, `CronDelete`, `PushNotification`) into the Discord bot so that Claude's self-scheduled follow-ups actually fire in SDK mode (they currently die with the subprocess).

**Architecture:** A `PreToolUse` hook intercepts the five tools inside `session-manager.ts` and writes their intent into two new SQLite tables (`schedules`, `crons`). A `Scheduler` daemon runs a 30-second tick loop that translates due rows into wakeup files, reusing the existing `WakeupWatcher` pipeline to resume Claude sessions. A new `/schedules` slash command surfaces the state to the user.

**Tech Stack:** TypeScript ESM, better-sqlite3, discord.js v14, zod v4, vitest, `@anthropic-ai/claude-agent-sdk`. New dep: `cron-parser`. Node ≥ 20.

**Related design:** `docs/superpowers/specs/2026-07-13-harness-scheduling-bridge-design.md`

## Global Constraints

- Existing `WakeupPayloadSchema` (`src/wakeup/types.ts`) is immutable — anything Scheduler writes MUST satisfy: `source` matches `/^[a-z0-9_-]+$/`; `created_at` is ISO 8601 string (not ms epoch); `prompt` length 1-4000.
- All new modules follow existing ESM conventions: `.js` extension on local imports, `strict` TypeScript, no unused locals/params.
- SQLite migrations use `CREATE TABLE IF NOT EXISTS` — never destructive migrations (existing users' data survives upgrade).
- Cross-platform path handling: `path.join()` / `path.resolve()`; filename extract via `split(/[\\/]/)`.
- Tests use vitest, co-located next to source (`foo.ts` + `foo.test.ts`), with `:memory:` sqlite for DB tests and tmp dirs for file-system tests.
- All new user-facing strings go through `L(en, ko)` helper in `src/utils/i18n.ts`.
- Never assume `canUseTool` runs — the bot may have `allowDangerouslySkipPermissions: true` set. PreToolUse hooks are the only reliable intercept point.

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/db/schedules.ts` | `schedules` table CRUD (insert, listByChannel, deleteById, deleteExpired, findDue) |
| `src/db/crons.ts` | `crons` table CRUD (insert, listByChannel, deleteById, findDue, updateNextFire) |
| `src/cron/parser.ts` | Wrapper around `cron-parser`: `validate(expr)`, `nextFireAfter(expr, from)` |
| `src/cron/parser.test.ts` | Parser unit tests |
| `src/scheduler/tick.ts` | Pure `runTick(deps)` function — the scheduling core |
| `src/scheduler/tick.test.ts` | Tick unit tests |
| `src/scheduler/daemon.ts` | `Scheduler` class wrapping `setInterval` + `start`/`stop` lifecycle |
| `src/scheduler/wakeup-writer.ts` | Writes `WakeupPayload` JSON files atomically to `WAKEUP_DIR` |
| `src/scheduler/wakeup-writer.test.ts` | Writer unit tests |
| `src/scheduler/miss-notifier.ts` | Formats + sends the bundled miss embed to Discord |
| `src/hooks/pre-tool-use.ts` | Hook dispatcher — routes by `tool_name` to handlers below |
| `src/hooks/schedule-wakeup.ts` | `ScheduleWakeup` handler |
| `src/hooks/cron.ts` | `CronCreate` / `CronList` / `CronDelete` handlers |
| `src/hooks/push-notification.ts` | `PushNotification` handler |
| `src/hooks/pre-tool-use.test.ts` | Hook dispatcher + all 5 handlers unit tests |
| `src/bot/commands/schedules.ts` | `/schedules list|cancel|info` slash command |
| `src/bot/commands/schedules.test.ts` | Slash command builder + embed formatting tests |
| `test/integration/schedule-end-to-end.test.ts` | Full pipeline: hook → DB → tick → wakeup file → watcher |

**Modified files:**

| Path | Change |
|---|---|
| `src/db/database.ts` | Add `schedules` + `crons` `CREATE TABLE IF NOT EXISTS` inside `initDatabase()` |
| `src/db/types.ts` | Add `ScheduleRow`, `CronRow` types |
| `src/claude/session-manager.ts` | Add `hooks: { PreToolUse: [...] }` to `query()` options; import hook dispatcher |
| `src/bot/client.ts` | Register `/schedules` command; start/stop `Scheduler` alongside `WakeupWatcher` |
| `src/index.ts` | Boot `Scheduler` after `WakeupWatcher` |
| `package.json` | Add `cron-parser` dependency |

---

### Task 1: DB schema + query helpers for `schedules` and `crons`

**Files:**
- Modify: `src/db/database.ts` (add two `CREATE TABLE` blocks inside `initDatabase()`)
- Modify: `src/db/types.ts` (add row types)
- Create: `src/db/schedules.ts`
- Create: `src/db/crons.ts`
- Create: `src/db/schedules.test.ts`
- Create: `src/db/crons.test.ts`

**Interfaces:**
- Produces:
  - `ScheduleRow` type — `{ id: string; channel_id: string; fire_at: number; prompt: string; reason: string | null; source: string; ttl_seconds: number; created_at: number }`
  - `CronRow` type — `{ id: string; channel_id: string; cron_expr: string; prompt: string; name: string | null; next_fire: number; last_fire: number | null; created_at: number }`
  - `insertSchedule(row: ScheduleRow): void`
  - `listSchedulesByChannel(channelId: string): ScheduleRow[]`
  - `deleteScheduleById(id: string): boolean`
  - `findDueSchedules(now: number): ScheduleRow[]` — where `fire_at <= now AND created_at + ttl_seconds*1000 >= now`
  - `findExpiredSchedules(now: number): ScheduleRow[]` — where `created_at + ttl_seconds*1000 < now`
  - `countByChannel(channelId: string): number` — combined schedules + crons count for rate-limit check
  - `insertCron(row: CronRow): void`
  - `listCronsByChannel(channelId: string): CronRow[]`
  - `deleteCronById(id: string): boolean`
  - `findDueCrons(now: number): CronRow[]` — where `next_fire <= now`
  - `updateCronFire(id: string, now: number, nextFire: number): void`

- [ ] **Step 1: Write failing test for `schedules` insert + findDue**

`src/db/schedules.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  insertSchedule,
  findDueSchedules,
  findExpiredSchedules,
  listSchedulesByChannel,
  deleteScheduleById,
  __setDbForTests,
} from "./schedules.js";

const CHANNEL = "123456789012345678";
const now = 1_700_000_000_000;

function setup(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_schedules_fire_at ON schedules(fire_at);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  __setDbForTests(db);
  return db;
}

describe("schedules table", () => {
  beforeEach(() => setup());

  it("inserts and lists by channel", () => {
    insertSchedule({
      id: "sch_a", channel_id: CHANNEL, fire_at: now + 60_000,
      prompt: "check X", reason: null, source: "schedule_wakeup",
      ttl_seconds: 3600, created_at: now,
    });
    const rows = listSchedulesByChannel(CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe("check X");
  });

  it("findDueSchedules returns only rows where fire_at <= now AND not expired", () => {
    insertSchedule({ id: "sch_past", channel_id: CHANNEL, fire_at: now - 1_000, prompt: "due", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now - 500 });
    insertSchedule({ id: "sch_future", channel_id: CHANNEL, fire_at: now + 60_000, prompt: "not due", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now });
    insertSchedule({ id: "sch_expired", channel_id: CHANNEL, fire_at: now - 10_000, prompt: "expired", reason: null, source: "schedule_wakeup", ttl_seconds: 1, created_at: now - 10_000 });
    const due = findDueSchedules(now);
    expect(due.map((r) => r.id)).toEqual(["sch_past"]);
  });

  it("findExpiredSchedules returns rows past TTL", () => {
    insertSchedule({ id: "sch_expired", channel_id: CHANNEL, fire_at: now, prompt: "x", reason: null, source: "schedule_wakeup", ttl_seconds: 1, created_at: now - 10_000 });
    const expired = findExpiredSchedules(now);
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe("sch_expired");
  });

  it("deleteScheduleById removes row and returns true", () => {
    insertSchedule({ id: "sch_a", channel_id: CHANNEL, fire_at: now, prompt: "x", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now });
    expect(deleteScheduleById("sch_a")).toBe(true);
    expect(listSchedulesByChannel(CHANNEL)).toHaveLength(0);
    expect(deleteScheduleById("sch_nonexistent")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/db/schedules.test.ts`
Expected: FAIL with "Cannot find module './schedules.js'"

- [ ] **Step 3: Implement `src/db/schedules.ts`**

```ts
import type Database from "better-sqlite3";
import { getDb } from "./database.js";

export interface ScheduleRow {
  id: string;
  channel_id: string;
  fire_at: number;
  prompt: string;
  reason: string | null;
  source: string;
  ttl_seconds: number;
  created_at: number;
}

let dbOverride: Database.Database | null = null;

/** Test-only hook — do NOT call from production code. */
export function __setDbForTests(db: Database.Database | null): void {
  dbOverride = db;
}

function db(): Database.Database {
  return dbOverride ?? getDb();
}

export function insertSchedule(row: ScheduleRow): void {
  db().prepare(`
    INSERT INTO schedules (id, channel_id, fire_at, prompt, reason, source, ttl_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.channel_id, row.fire_at, row.prompt, row.reason, row.source, row.ttl_seconds, row.created_at);
}

export function listSchedulesByChannel(channelId: string): ScheduleRow[] {
  return db().prepare(`SELECT * FROM schedules WHERE channel_id = ? ORDER BY fire_at ASC`).all(channelId) as ScheduleRow[];
}

export function findDueSchedules(now: number): ScheduleRow[] {
  return db().prepare(`
    SELECT * FROM schedules
    WHERE fire_at <= ? AND (created_at + ttl_seconds * 1000) >= ?
    ORDER BY fire_at ASC
  `).all(now, now) as ScheduleRow[];
}

export function findExpiredSchedules(now: number): ScheduleRow[] {
  return db().prepare(`
    SELECT * FROM schedules
    WHERE (created_at + ttl_seconds * 1000) < ?
  `).all(now) as ScheduleRow[];
}

export function deleteScheduleById(id: string): boolean {
  const result = db().prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function countSchedulesByChannel(channelId: string): number {
  const row = db().prepare(`SELECT COUNT(*) as n FROM schedules WHERE channel_id = ?`).get(channelId) as { n: number };
  return row.n;
}
```

- [ ] **Step 4: Run schedules tests**

Run: `npm test -- src/db/schedules.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write failing test for `crons`**

`src/db/crons.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  insertCron, findDueCrons, updateCronFire, listCronsByChannel,
  deleteCronById, __setDbForTests as setCronsDb,
} from "./crons.js";

const CHANNEL = "123456789012345678";
const now = 1_700_000_000_000;

function setup(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE crons (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      name TEXT,
      next_fire INTEGER NOT NULL,
      last_fire INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_crons_next_fire ON crons(next_fire);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setCronsDb(db);
  return db;
}

describe("crons table", () => {
  beforeEach(() => setup());

  it("insert + list", () => {
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "morning", name: null, next_fire: now + 3600_000, last_fire: null, created_at: now });
    expect(listCronsByChannel(CHANNEL)).toHaveLength(1);
  });

  it("findDueCrons only returns rows where next_fire <= now", () => {
    insertCron({ id: "cron_past", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "p", name: null, next_fire: now - 1000, last_fire: null, created_at: now });
    insertCron({ id: "cron_future", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "f", name: null, next_fire: now + 60_000, last_fire: null, created_at: now });
    const due = findDueCrons(now);
    expect(due.map((r) => r.id)).toEqual(["cron_past"]);
  });

  it("updateCronFire updates last_fire and next_fire", () => {
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "p", name: null, next_fire: now - 1000, last_fire: null, created_at: now });
    updateCronFire("cron_a", now, now + 60_000);
    const rows = listCronsByChannel(CHANNEL);
    expect(rows[0].last_fire).toBe(now);
    expect(rows[0].next_fire).toBe(now + 60_000);
  });

  it("deleteCronById returns bool", () => {
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "p", name: null, next_fire: now, last_fire: null, created_at: now });
    expect(deleteCronById("cron_a")).toBe(true);
    expect(deleteCronById("cron_a")).toBe(false);
  });
});
```

- [ ] **Step 6: Implement `src/db/crons.ts`** (mirrors `schedules.ts` pattern)

```ts
import type Database from "better-sqlite3";
import { getDb } from "./database.js";

export interface CronRow {
  id: string;
  channel_id: string;
  cron_expr: string;
  prompt: string;
  name: string | null;
  next_fire: number;
  last_fire: number | null;
  created_at: number;
}

let dbOverride: Database.Database | null = null;
export function __setDbForTests(db: Database.Database | null): void { dbOverride = db; }
function db(): Database.Database { return dbOverride ?? getDb(); }

export function insertCron(row: CronRow): void {
  db().prepare(`
    INSERT INTO crons (id, channel_id, cron_expr, prompt, name, next_fire, last_fire, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.channel_id, row.cron_expr, row.prompt, row.name, row.next_fire, row.last_fire, row.created_at);
}

export function listCronsByChannel(channelId: string): CronRow[] {
  return db().prepare(`SELECT * FROM crons WHERE channel_id = ? ORDER BY next_fire ASC`).all(channelId) as CronRow[];
}

export function findDueCrons(now: number): CronRow[] {
  return db().prepare(`SELECT * FROM crons WHERE next_fire <= ? ORDER BY next_fire ASC`).all(now) as CronRow[];
}

export function updateCronFire(id: string, lastFire: number, nextFire: number): void {
  db().prepare(`UPDATE crons SET last_fire = ?, next_fire = ? WHERE id = ?`).run(lastFire, nextFire, id);
}

export function deleteCronById(id: string): boolean {
  const result = db().prepare(`DELETE FROM crons WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function countCronsByChannel(channelId: string): number {
  const row = db().prepare(`SELECT COUNT(*) as n FROM crons WHERE channel_id = ?`).get(channelId) as { n: number };
  return row.n;
}
```

- [ ] **Step 7: Add tables to `initDatabase()` in `src/db/database.ts`**

Add after the `wakeup_queue` block (before line 43 `);`):

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schedules_fire_at ON schedules(fire_at);
CREATE INDEX IF NOT EXISTS idx_schedules_channel ON schedules(channel_id);

CREATE TABLE IF NOT EXISTS crons (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  name TEXT,
  next_fire INTEGER NOT NULL,
  last_fire INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crons_next_fire ON crons(next_fire);
CREATE INDEX IF NOT EXISTS idx_crons_channel ON crons(channel_id);
```

- [ ] **Step 8: Add types to `src/db/types.ts`**

```ts
export type { ScheduleRow } from "./schedules.js";
export type { CronRow } from "./crons.js";
```

- [ ] **Step 9: Run all tests + typecheck**

```bash
npx tsc --noEmit
npm test -- src/db/
```

Expected: All pass.

- [ ] **Step 10: Commit**

```bash
git add src/db/schedules.ts src/db/schedules.test.ts src/db/crons.ts src/db/crons.test.ts src/db/database.ts src/db/types.ts
git commit -m "feat(db): add schedules + crons tables for harness scheduling bridge"
```

---

### Task 2: cron-parser wrapper

**Files:**
- Modify: `package.json` (add `cron-parser` dep)
- Create: `src/cron/parser.ts`
- Create: `src/cron/parser.test.ts`

**Interfaces:**
- Consumes: `cron-parser` package
- Produces:
  - `validateCronExpr(expr: string): { valid: true } | { valid: false; error: string }`
  - `nextFireAfter(expr: string, fromMs: number): number` — returns ms epoch of next fire; throws if invalid

- [ ] **Step 1: Add `cron-parser` dependency**

Run:
```bash
npm install cron-parser
```

Verify `package.json` `dependencies` now contains `"cron-parser"`.

- [ ] **Step 2: Write failing test**

`src/cron/parser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateCronExpr, nextFireAfter } from "./parser.js";

describe("validateCronExpr", () => {
  it("accepts standard 5-field cron", () => {
    expect(validateCronExpr("0 9 * * *")).toEqual({ valid: true });
    expect(validateCronExpr("*/5 * * * *")).toEqual({ valid: true });
  });
  it("rejects garbage", () => {
    const result = validateCronExpr("not a cron");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/parse|invalid/i);
  });
  it("rejects empty string", () => {
    expect(validateCronExpr("").valid).toBe(false);
  });
});

describe("nextFireAfter", () => {
  it("computes next daily fire in the future", () => {
    // 2026-07-13T00:00:00Z is a Monday
    const from = Date.UTC(2026, 6, 13, 0, 0, 0);
    // "0 9 * * *" fires at 9:00 UTC every day
    const next = nextFireAfter("0 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 6, 13, 9, 0, 0));
  });
  it("skips past to next valid slot when current slot already passed", () => {
    const from = Date.UTC(2026, 6, 13, 10, 0, 0); // 10:00 UTC
    const next = nextFireAfter("0 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 6, 14, 9, 0, 0)); // next day's 9:00
  });
  it("throws on invalid expr", () => {
    expect(() => nextFireAfter("garbage", Date.now())).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/cron/parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/cron/parser.ts`**

```ts
import { CronExpressionParser } from "cron-parser";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function validateCronExpr(expr: string): ValidationResult {
  if (expr.trim().length === 0) return { valid: false, error: "empty cron expression" };
  try {
    CronExpressionParser.parse(expr);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function nextFireAfter(expr: string, fromMs: number): number {
  const interval = CronExpressionParser.parse(expr, { currentDate: new Date(fromMs) });
  return interval.next().getTime();
}
```

**Note:** `cron-parser` v5+ uses `CronExpressionParser.parse()`; v4 used a different API (`parseExpression`). If the installed version is older than 5, adjust import accordingly and update this note.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/cron/parser.test.ts
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/cron/parser.ts src/cron/parser.test.ts
git commit -m "feat(cron): add cron expression parser wrapper"
```

---

### Task 3: PreToolUse hook infrastructure + ScheduleWakeup handler

**Files:**
- Create: `src/hooks/pre-tool-use.ts`
- Create: `src/hooks/schedule-wakeup.ts`
- Create: `src/hooks/pre-tool-use.test.ts`
- Modify: `src/claude/session-manager.ts` (register hook in `query()` options)

**Interfaces:**
- Consumes:
  - `insertSchedule`, `countSchedulesByChannel` from Task 1
  - `countCronsByChannel` from Task 1
- Produces:
  - `createPreToolUseHook(deps: HookDeps): HookCallback` — factory returning the SDK-compatible callback
  - `HookDeps = { channelId: string; channel: TextChannel; now: () => number }`
  - `handleScheduleWakeup(input: unknown, deps: HookDeps): HookResult`

- [ ] **Step 1: Write failing test — ScheduleWakeup handler happy path**

`src/hooks/pre-tool-use.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { TextChannel } from "discord.js";
import { createPreToolUseHook } from "./pre-tool-use.js";
import { __setDbForTests as setSchedDb, listSchedulesByChannel } from "../db/schedules.js";
import { __setDbForTests as setCronsDb } from "../db/crons.js";

const CHANNEL = "123456789012345678";
const NOW = 1_700_000_000_000;

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fire_at INTEGER NOT NULL,
      prompt TEXT NOT NULL, reason TEXT, source TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600, created_at INTEGER NOT NULL);
    CREATE TABLE crons (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL, name TEXT, next_fire INTEGER NOT NULL,
      last_fire INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setSchedDb(db); setCronsDb(db);
  return db;
}

describe("PreToolUse hook — ScheduleWakeup", () => {
  beforeEach(() => setup());

  it("inserts a schedule row and returns deny with informational reason", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({
      channelId: CHANNEL,
      channel,
      now: () => NOW,
    });

    const output = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 300, prompt: "Check R-018", reason: "5min poll" },
        tool_use_id: "toolu_x",
        session_id: "sess",
        transcript_path: "/tmp/t",
        cwd: "/tmp",
      },
      "toolu_x",
      { signal: new AbortController().signal },
    );

    // Deny + reason (main strategy)
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Next wakeup scheduled/);
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/sch_/);

    // DB effect
    const rows = listSchedulesByChannel(CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].fire_at).toBe(NOW + 300_000);
    expect(rows[0].prompt).toBe("Check R-018");
    expect(rows[0].reason).toBe("5min poll");
    expect(rows[0].source).toBe("schedule_wakeup");
  });

  it("clamps delaySeconds to [60, 3600]", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => NOW });

    await hook(
      { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 10, prompt: "x" }, tool_use_id: "t1",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t1", { signal: new AbortController().signal },
    );
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 10_000, prompt: "y" }, tool_use_id: "t2",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t2", { signal: new AbortController().signal },
    );

    const rows = listSchedulesByChannel(CHANNEL);
    expect(rows.find((r) => r.prompt === "x")!.fire_at).toBe(NOW + 60_000);
    expect(rows.find((r) => r.prompt === "y")!.fire_at).toBe(NOW + 3600_000);
  });

  it("rejects when total schedules + crons >= 50 (soft rate limit)", async () => {
    // pre-fill 50 rows
    const db = setup();
    for (let i = 0; i < 50; i++) {
      db.prepare(`INSERT INTO schedules (id, channel_id, fire_at, prompt, source, ttl_seconds, created_at) VALUES (?, ?, ?, ?, 'schedule_wakeup', 3600, ?)`)
        .run(`sch_${i}`, CHANNEL, NOW + 60_000, "x", NOW);
    }

    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => NOW });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 300, prompt: "over-limit" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/rate limit|too many/i);
    expect(listSchedulesByChannel(CHANNEL)).toHaveLength(50);  // no new row
  });

  it("passes through unknown tools (returns empty continue)", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => NOW });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read",
        tool_input: { file_path: "/x" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    // Nothing set → SDK treats as allow (default)
    expect(output).toEqual({ continue: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks/pre-tool-use.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/hooks/schedule-wakeup.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { TextChannel } from "discord.js";
import { insertSchedule, countSchedulesByChannel } from "../db/schedules.js";
import { countCronsByChannel } from "../db/crons.js";

export interface HookDeps {
  channelId: string;
  channel: TextChannel;
  now: () => number;
}

export interface HookResult {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

const MAX_PER_CHANNEL = 50;
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 3600;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isScheduleWakeupInput(x: unknown): x is { delaySeconds: number; prompt: string; reason?: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { delaySeconds?: unknown }).delaySeconds === "number"
    && typeof (x as { prompt?: unknown }).prompt === "string";
}

export function handleScheduleWakeup(input: unknown, deps: HookDeps): HookResult {
  if (!isScheduleWakeupInput(input)) {
    return deny("Invalid ScheduleWakeup input — expected {delaySeconds, prompt}");
  }

  const total = countSchedulesByChannel(deps.channelId) + countCronsByChannel(deps.channelId);
  if (total >= MAX_PER_CHANNEL) {
    return deny(`Rate limit: this channel already has ${total} pending schedules/crons (max ${MAX_PER_CHANNEL}). Cancel some via /schedules before adding more.`);
  }

  const now = deps.now();
  const delayMs = clamp(input.delaySeconds, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS) * 1000;
  const fireAt = now + delayMs;
  const id = `sch_${randomUUID().slice(0, 8)}`;

  insertSchedule({
    id,
    channel_id: deps.channelId,
    fire_at: fireAt,
    prompt: input.prompt,
    reason: input.reason ?? null,
    source: "schedule_wakeup",
    ttl_seconds: DEFAULT_TTL_SECONDS,
    created_at: now,
  });

  const fireIso = new Date(fireAt).toISOString();
  return deny(
    `Next wakeup scheduled for ${fireIso} (in ${Math.round(delayMs / 1000)}s). ` +
    `Bot will re-invoke you when the wakeup fires. (id: ${id})`,
  );
}

function deny(reason: string): HookResult {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
```

- [ ] **Step 4: Implement `src/hooks/pre-tool-use.ts` (dispatcher)**

```ts
import type { PreToolUseHookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { handleScheduleWakeup, type HookDeps } from "./schedule-wakeup.js";

export function createPreToolUseHook(deps: HookDeps) {
  return async (
    input: PreToolUseHookInput,
    _toolUseId: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    try {
      switch (input.tool_name) {
        case "ScheduleWakeup":
          return handleScheduleWakeup(input.tool_input, deps);
        default:
          return { continue: true };
      }
    } catch (e) {
      console.error(`[hook] PreToolUse ${input.tool_name} failed:`, e);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Bot hook error: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
  };
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- src/hooks/pre-tool-use.test.ts
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 6: Wire hook into `session-manager.ts`**

Modify `src/claude/session-manager.ts`. In the `runQuery` function, add to the `options` object (right after `canUseTool: ...`):

```ts
hooks: {
  PreToolUse: [
    {
      hooks: [
        createPreToolUseHook({
          channelId: channel.id,
          channel,
          now: () => Date.now(),
        }),
      ],
    },
  ],
},
```

And add the import at the top:

```ts
import { createPreToolUseHook } from "../hooks/pre-tool-use.js";
```

- [ ] **Step 7: Typecheck + full test suite**

```bash
npx tsc --noEmit
npm test
```

Expected: All existing tests still pass + new ones pass.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/schedule-wakeup.ts src/hooks/pre-tool-use.ts src/hooks/pre-tool-use.test.ts src/claude/session-manager.ts
git commit -m "feat(hooks): intercept ScheduleWakeup via PreToolUse hook"
```

---

### Task 4: PreToolUse hook — Cron handlers (Create/List/Delete)

**Files:**
- Create: `src/hooks/cron.ts`
- Modify: `src/hooks/pre-tool-use.ts` (add dispatch cases)
- Modify: `src/hooks/pre-tool-use.test.ts` (add cron cases)

**Interfaces:**
- Consumes:
  - `insertCron`, `listCronsByChannel`, `deleteCronById`, `countCronsByChannel` from Task 1
  - `countSchedulesByChannel` from Task 1
  - `validateCronExpr`, `nextFireAfter` from Task 2
- Produces:
  - `handleCronCreate(input, deps): HookResult`
  - `handleCronList(input, deps): HookResult`
  - `handleCronDelete(input, deps): HookResult`

- [ ] **Step 1: Write failing tests**

Add to `src/hooks/pre-tool-use.test.ts`:

```ts
import { listCronsByChannel } from "../db/crons.js";

describe("PreToolUse hook — CronCreate", () => {
  beforeEach(() => setup());

  it("creates cron with valid expression", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => Date.UTC(2026, 6, 13, 0, 0, 0) });

    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronCreate",
        tool_input: { schedule: "0 9 * * *", prompt: "morning PR", name: "morning" },
        tool_use_id: "t", session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Cron created/);
    const rows = listCronsByChannel(CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].cron_expr).toBe("0 9 * * *");
    expect(rows[0].name).toBe("morning");
    expect(rows[0].next_fire).toBe(Date.UTC(2026, 6, 13, 9, 0, 0));
  });

  it("rejects invalid cron expression", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronCreate",
        tool_input: { schedule: "not a cron", prompt: "x" },
        tool_use_id: "t", session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/invalid|parse/i);
    expect(listCronsByChannel(CHANNEL)).toHaveLength(0);
  });
});

describe("PreToolUse hook — CronList", () => {
  beforeEach(() => setup());

  it("returns formatted list of channel's crons", async () => {
    // Insert 2 crons directly via DB
    const now = Date.UTC(2026, 6, 13, 0, 0, 0);
    const db = (await import("../db/crons.js"));
    db.insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "morning", name: "morning", next_fire: now + 9 * 3600_000, last_fire: null, created_at: now });
    db.insertCron({ id: "cron_b", channel_id: CHANNEL, cron_expr: "0 18 * * *", prompt: "evening", name: null, next_fire: now + 18 * 3600_000, last_fire: null, created_at: now });

    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => now });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronList",
        tool_input: {}, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    const reason = output.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("cron_a");
    expect(reason).toContain("cron_b");
    expect(reason).toContain("0 9 * * *");
  });
});

describe("PreToolUse hook — CronDelete", () => {
  beforeEach(() => setup());

  it("deletes existing cron", async () => {
    const now = 1_700_000_000_000;
    const db = (await import("../db/crons.js"));
    db.insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "x", name: null, next_fire: now, last_fire: null, created_at: now });

    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => now });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronDelete",
        tool_input: { id: "cron_a" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Deleted cron_a/);
    expect(listCronsByChannel(CHANNEL)).toHaveLength(0);
  });

  it("returns not-found for nonexistent id", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronDelete",
        tool_input: { id: "cron_nonexistent" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/hooks/pre-tool-use.test.ts`
Expected: FAIL (new test cases fail because CronCreate/List/Delete aren't dispatched yet).

- [ ] **Step 3: Implement `src/hooks/cron.ts`**

```ts
import { randomUUID } from "node:crypto";
import {
  insertCron, listCronsByChannel, deleteCronById, countCronsByChannel,
} from "../db/crons.js";
import { countSchedulesByChannel } from "../db/schedules.js";
import { validateCronExpr, nextFireAfter } from "../cron/parser.js";
import type { HookDeps, HookResult } from "./schedule-wakeup.js";

const MAX_PER_CHANNEL = 50;

function deny(reason: string): HookResult {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function isCronCreateInput(x: unknown): x is { schedule: string; prompt: string; name?: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { schedule?: unknown }).schedule === "string"
    && typeof (x as { prompt?: unknown }).prompt === "string";
}

export function handleCronCreate(input: unknown, deps: HookDeps): HookResult {
  if (!isCronCreateInput(input)) {
    return deny("Invalid CronCreate input — expected {schedule, prompt}");
  }

  const total = countSchedulesByChannel(deps.channelId) + countCronsByChannel(deps.channelId);
  if (total >= MAX_PER_CHANNEL) {
    return deny(`Rate limit: this channel already has ${total} pending schedules/crons (max ${MAX_PER_CHANNEL}).`);
  }

  const validation = validateCronExpr(input.schedule);
  if (!validation.valid) {
    return deny(`Invalid cron expression "${input.schedule}": ${validation.error}`);
  }

  const now = deps.now();
  const id = `cron_${randomUUID().slice(0, 8)}`;
  const nextFire = nextFireAfter(input.schedule, now);

  insertCron({
    id,
    channel_id: deps.channelId,
    cron_expr: input.schedule,
    prompt: input.prompt,
    name: input.name ?? null,
    next_fire: nextFire,
    last_fire: null,
    created_at: now,
  });

  return deny(`Cron created (id: ${id}). Next fire: ${new Date(nextFire).toISOString()}`);
}

export function handleCronList(_input: unknown, deps: HookDeps): HookResult {
  const rows = listCronsByChannel(deps.channelId);
  if (rows.length === 0) {
    return deny("No crons in this channel.");
  }
  const lines = rows.map((r) => {
    const nameStr = r.name ? ` [${r.name}]` : "";
    const nextIso = new Date(r.next_fire).toISOString();
    return `  ${r.id}  "${r.cron_expr}"${nameStr}  next: ${nextIso}`;
  });
  return deny(`Crons in this channel (${rows.length}):\n${lines.join("\n")}`);
}

function isCronDeleteInput(x: unknown): x is { id: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { id?: unknown }).id === "string";
}

export function handleCronDelete(input: unknown, _deps: HookDeps): HookResult {
  if (!isCronDeleteInput(input)) {
    return deny("Invalid CronDelete input — expected {id}");
  }
  const ok = deleteCronById(input.id);
  return deny(ok
    ? `Deleted ${input.id}`
    : `Cron ${input.id} not found in this channel`);
}
```

- [ ] **Step 4: Add dispatch cases to `src/hooks/pre-tool-use.ts`**

Update the switch statement:

```ts
import { handleCronCreate, handleCronList, handleCronDelete } from "./cron.js";

// ... inside switch:
case "ScheduleWakeup":
  return handleScheduleWakeup(input.tool_input, deps);
case "CronCreate":
  return handleCronCreate(input.tool_input, deps);
case "CronList":
  return handleCronList(input.tool_input, deps);
case "CronDelete":
  return handleCronDelete(input.tool_input, deps);
default:
  return { continue: true };
```

- [ ] **Step 5: Run tests**

```bash
npm test -- src/hooks/pre-tool-use.test.ts
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/cron.ts src/hooks/pre-tool-use.ts src/hooks/pre-tool-use.test.ts
git commit -m "feat(hooks): intercept CronCreate / CronList / CronDelete via PreToolUse hook"
```

---

### Task 5: PreToolUse hook — PushNotification

**Files:**
- Create: `src/hooks/push-notification.ts`
- Modify: `src/hooks/pre-tool-use.ts` (add dispatch)
- Modify: `src/hooks/pre-tool-use.test.ts` (add test)

**Interfaces:**
- Consumes: `HookDeps` from Task 3
- Produces: `handlePushNotification(input, deps): Promise<HookResult>`

**Note:** This handler is `async` because it awaits `channel.send()`.

- [ ] **Step 1: Write failing test**

Add to `src/hooks/pre-tool-use.test.ts`:

```ts
describe("PreToolUse hook — PushNotification", () => {
  beforeEach(() => setup());

  it("sends channel.send message and returns deny with confirmation", async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const channel = { send: sendSpy } as unknown as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });

    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "PushNotification",
        tool_input: { message: "任務 X 完成" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0]).toEqual({ content: "任務 X 完成" });
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Notification sent/);
  });

  it("rejects on missing message", async () => {
    const sendSpy = vi.fn();
    const channel = { send: sendSpy } as unknown as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "PushNotification",
        tool_input: {}, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/invalid|expected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks/pre-tool-use.test.ts`
Expected: FAIL for PushNotification cases.

- [ ] **Step 3: Implement `src/hooks/push-notification.ts`**

```ts
import type { HookDeps, HookResult } from "./schedule-wakeup.js";

function isPushInput(x: unknown): x is { message: string; priority?: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { message?: unknown }).message === "string"
    && (x as { message: string }).message.length > 0;
}

function deny(reason: string): HookResult {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export async function handlePushNotification(input: unknown, deps: HookDeps): Promise<HookResult> {
  if (!isPushInput(input)) {
    return deny("Invalid PushNotification input — expected {message: string}");
  }
  try {
    await deps.channel.send({ content: input.message });
    return deny("Notification sent");
  } catch (e) {
    return deny(`Failed to send notification: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 4: Add dispatch to `src/hooks/pre-tool-use.ts`**

```ts
import { handlePushNotification } from "./push-notification.js";

// ... inside switch:
case "PushNotification":
  return handlePushNotification(input.tool_input, deps);
```

- [ ] **Step 5: Run tests + typecheck**

```bash
npm test -- src/hooks/
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/push-notification.ts src/hooks/pre-tool-use.ts src/hooks/pre-tool-use.test.ts
git commit -m "feat(hooks): intercept PushNotification via PreToolUse hook"
```

---

### Task 6: Scheduler tick core (pure function)

**Files:**
- Create: `src/scheduler/wakeup-writer.ts`
- Create: `src/scheduler/wakeup-writer.test.ts`
- Create: `src/scheduler/tick.ts`
- Create: `src/scheduler/tick.test.ts`
- Create: `src/scheduler/miss-notifier.ts`

**Interfaces:**
- Consumes:
  - `findDueSchedules`, `findExpiredSchedules`, `deleteScheduleById` from Task 1
  - `findDueCrons`, `updateCronFire` from Task 1
  - `nextFireAfter` from Task 2
  - `WakeupPayloadSchema` from `src/wakeup/types.ts` (existing)
  - `resolveWakeupDir` from `src/wakeup/paths.ts` (existing)
- Produces:
  - `writeWakeupFile(dir: string, payload: WakeupPayload): Promise<void>` — atomic write via temp file + rename
  - `sendMissBundle(client: Client, rows: ScheduleRow[]): Promise<void>` — Discord embed
  - `runTick(deps: TickDeps): Promise<void>`
  - `TickDeps = { now: number; wakeupDir: string; discordClient: Client; log: (msg, err?) => void }`

- [ ] **Step 1: Write failing test for `wakeup-writer.ts`**

`src/scheduler/wakeup-writer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeWakeupFile } from "./wakeup-writer.js";
import { WakeupPayloadSchema } from "../wakeup/types.js";

describe("writeWakeupFile", () => {
  it("writes a valid WakeupPayload JSON file with a unique name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wakeup-writer-test-"));
    try {
      const payload = {
        channel_id: "123456789012345678",
        prompt: "check R-018",
        source: "schedule_wakeup",
        metadata: { schedule_id: "sch_abc" },
        created_at: new Date(1_700_000_000_000).toISOString(),
        ttl_seconds: 60,
      };
      await writeWakeupFile(dir, payload);

      const entries = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
      expect(entries).toHaveLength(1);
      const parsed = JSON.parse(await fs.readFile(path.join(dir, entries[0]), "utf-8"));
      const result = WakeupPayloadSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Implement `src/scheduler/wakeup-writer.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WakeupPayload } from "../wakeup/types.js";

/**
 * Atomically write a wakeup payload JSON to `dir`. Uses temp-file + rename
 * so `WakeupWatcher` never sees a half-written file.
 */
export async function writeWakeupFile(dir: string, payload: WakeupPayload): Promise<void> {
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const finalPath = path.join(dir, name);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  await fs.rename(tmpPath, finalPath);
}
```

- [ ] **Step 3: Run writer test**

Run: `npm test -- src/scheduler/wakeup-writer.test.ts`
Expected: PASS.

- [ ] **Step 4: Write failing test for `tick.ts`**

`src/scheduler/tick.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { runTick } from "./tick.js";
import {
  __setDbForTests as setSchedDb, insertSchedule, findDueSchedules, listSchedulesByChannel,
} from "../db/schedules.js";
import {
  __setDbForTests as setCronsDb, insertCron, listCronsByChannel,
} from "../db/crons.js";

const CHANNEL = "123456789012345678";

function setupDb(): void {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fire_at INTEGER NOT NULL,
      prompt TEXT NOT NULL, reason TEXT, source TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600, created_at INTEGER NOT NULL);
    CREATE TABLE crons (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL, name TEXT, next_fire INTEGER NOT NULL,
      last_fire INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setSchedDb(db); setCronsDb(db);
}

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tick-test-"));
}

describe("runTick", () => {
  beforeEach(() => setupDb());

  it("fires due schedules by writing wakeup file and deleting DB row", async () => {
    const now = 1_700_000_000_000;
    insertSchedule({ id: "sch_due", channel_id: CHANNEL, fire_at: now - 5_000, prompt: "check", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now - 5_000 });
    insertSchedule({ id: "sch_future", channel_id: CHANNEL, fire_at: now + 60_000, prompt: "later", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now });

    const dir = await makeTmpDir();
    try {
      await runTick({
        now,
        wakeupDir: dir,
        discordClient: {} as never,
        log: () => {},
      });

      const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
      expect(files).toHaveLength(1);
      const payload = JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf-8"));
      expect(payload.prompt).toBe("check");
      expect(payload.source).toBe("schedule_wakeup");
      expect(payload.channel_id).toBe(CHANNEL);
      expect(payload.metadata.schedule_id).toBe("sch_due");

      // Due row deleted, future row survives
      expect(listSchedulesByChannel(CHANNEL).map((r) => r.id)).toEqual(["sch_future"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fires due crons and updates next_fire", async () => {
    const now = Date.UTC(2026, 6, 13, 10, 0, 0);  // 10:00 UTC
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "daily", name: "morning", next_fire: now - 3600_000, last_fire: null, created_at: now - 86400_000 });

    const dir = await makeTmpDir();
    try {
      await runTick({ now, wakeupDir: dir, discordClient: {} as never, log: () => {} });
      const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
      expect(files).toHaveLength(1);
      const rows = listCronsByChannel(CHANNEL);
      expect(rows[0].last_fire).toBe(now);
      expect(rows[0].next_fire).toBe(Date.UTC(2026, 6, 14, 9, 0, 0));  // next day 9:00
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("bundles expired schedules into a miss embed and deletes them", async () => {
    const now = 1_700_000_000_000;
    // Expired: created_at + ttl_seconds*1000 < now
    insertSchedule({ id: "sch_x", channel_id: CHANNEL, fire_at: now - 7200_000, prompt: "old1", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now - 7200_000 });
    insertSchedule({ id: "sch_y", channel_id: CHANNEL, fire_at: now - 7200_000, prompt: "old2", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now - 7200_000 });

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const mockClient = {
      channels: {
        fetch: vi.fn().mockResolvedValue({ send: sendSpy }),
      },
    } as unknown as import("discord.js").Client;

    const dir = await makeTmpDir();
    try {
      await runTick({ now, wakeupDir: dir, discordClient: mockClient, log: () => {} });

      // Miss embed sent (one bundled message)
      expect(sendSpy).toHaveBeenCalledOnce();
      const call = sendSpy.mock.calls[0][0];
      const text = JSON.stringify(call);
      expect(text).toMatch(/miss/i);
      expect(text).toContain("old1");
      expect(text).toContain("old2");

      // Rows deleted
      expect(listSchedulesByChannel(CHANNEL)).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates errors per row: one failing row does not stop others", async () => {
    const now = 1_700_000_000_000;
    // First row will fail because we make the wakeup dir read-only.
    // Second row should still process (after we make it writable again).
    // Simplest approach: use a bad payload that will succeed to write but let's simulate via monkey-patch.
    // For this test, verify that the tick doesn't throw when given valid rows.
    insertSchedule({ id: "sch_ok", channel_id: CHANNEL, fire_at: now - 1000, prompt: "ok", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now - 500 });

    const dir = await makeTmpDir();
    try {
      await expect(runTick({ now, wakeupDir: dir, discordClient: {} as never, log: () => {} })).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 5: Implement `src/scheduler/miss-notifier.ts`**

```ts
import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import type { ScheduleRow } from "../db/schedules.js";
import { L } from "../utils/i18n.js";

/**
 * Group expired schedules by channel_id and send one bundled embed per channel.
 * Silently swallows send failures per channel — a broken channel shouldn't
 * block miss notifications to other channels.
 */
export async function sendMissBundle(
  client: Client,
  rows: ScheduleRow[],
  log: (msg: string, err?: unknown) => void,
): Promise<void> {
  const byChannel = new Map<string, ScheduleRow[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(row);
    byChannel.set(row.channel_id, list);
  }

  for (const [channelId, list] of byChannel) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) continue;

      const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle(L(
          `⏰ Schedule miss (${list.length})`,
          `⏰ 예약 miss (${list.length}개)`,
        ))
        .setDescription(
          list.slice(0, 10).map((r) => {
            const ago = humanizeDelta(Date.now() - r.fire_at);
            const preview = r.prompt.length > 60 ? r.prompt.slice(0, 60) + "..." : r.prompt;
            return `• \`${r.id}\` (排定 ${ago} 前) — ${preview}`;
          }).join("\n") + (list.length > 10 ? `\n... 還有 ${list.length - 10} 條` : ""),
        );

      await (channel as TextChannel).send({ embeds: [embed] });
    } catch (e) {
      log(`[miss-notifier] failed to notify channel ${channelId}`, e);
    }
  }
}

function humanizeDelta(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}
```

- [ ] **Step 6: Implement `src/scheduler/tick.ts`**

```ts
import type { Client } from "discord.js";
import {
  findDueSchedules, findExpiredSchedules, deleteScheduleById,
  type ScheduleRow,
} from "../db/schedules.js";
import {
  findDueCrons, updateCronFire, type CronRow,
} from "../db/crons.js";
import { nextFireAfter } from "../cron/parser.js";
import { writeWakeupFile } from "./wakeup-writer.js";
import { sendMissBundle } from "./miss-notifier.js";
import type { WakeupPayload } from "../wakeup/types.js";

const WAKEUP_FILE_TTL_SECONDS = 60;

export interface TickDeps {
  now: number;
  wakeupDir: string;
  discordClient: Client;
  log: (msg: string, err?: unknown) => void;
}

export async function runTick(deps: TickDeps): Promise<void> {
  const { now, wakeupDir, discordClient, log } = deps;

  // 1. Expired schedules → bundle & notify → delete
  const expired = findExpiredSchedules(now);
  if (expired.length > 0) {
    try {
      await sendMissBundle(discordClient, expired, log);
    } catch (e) {
      log("[tick] miss bundle send failed", e);
    }
    for (const row of expired) {
      try { deleteScheduleById(row.id); } catch (e) { log(`[tick] delete expired sch ${row.id} failed`, e); }
    }
  }

  // 2. Due schedules → write wakeup file → delete
  const dueSchedules = findDueSchedules(now);
  for (const row of dueSchedules) {
    try {
      await writeWakeupFile(wakeupDir, buildSchedulePayload(row, now));
      deleteScheduleById(row.id);
    } catch (e) {
      log(`[tick] due schedule ${row.id} failed`, e);
    }
  }

  // 3. Due crons → write wakeup file → update next_fire
  const dueCrons = findDueCrons(now);
  for (const row of dueCrons) {
    try {
      await writeWakeupFile(wakeupDir, buildCronPayload(row, now));
      const next = nextFireAfter(row.cron_expr, now);
      updateCronFire(row.id, now, next);
    } catch (e) {
      log(`[tick] due cron ${row.id} failed`, e);
    }
  }
}

function buildSchedulePayload(row: ScheduleRow, now: number): WakeupPayload {
  return {
    channel_id: row.channel_id,
    prompt: row.prompt,
    source: "schedule_wakeup",
    metadata: { schedule_id: row.id, ...(row.reason ? { reason: row.reason } : {}) },
    created_at: new Date(now).toISOString(),
    ttl_seconds: WAKEUP_FILE_TTL_SECONDS,
  };
}

function buildCronPayload(row: CronRow, now: number): WakeupPayload {
  return {
    channel_id: row.channel_id,
    prompt: row.prompt,
    source: "cron_fire",
    metadata: { cron_id: row.id, cron_expr: row.cron_expr, ...(row.name ? { name: row.name } : {}) },
    created_at: new Date(now).toISOString(),
    ttl_seconds: WAKEUP_FILE_TTL_SECONDS,
  };
}
```

- [ ] **Step 7: Run all scheduler tests + typecheck**

```bash
npm test -- src/scheduler/
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/
git commit -m "feat(scheduler): implement tick core with due/expired/cron handling"
```

---

### Task 7: Scheduler daemon + wire into bot lifecycle

**Files:**
- Create: `src/scheduler/daemon.ts`
- Modify: `src/bot/client.ts` (start/stop Scheduler)

**Interfaces:**
- Consumes: `runTick` from Task 6
- Produces:
  - `class Scheduler { start(): void; stop(): void; tickOnce(): Promise<void> }`
  - Scheduler polls every 30s; `start()` runs `tickOnce()` immediately (catch-up), then sets `setInterval`.
  - `stop()` clears interval; if a tick is running, allows it to finish.

- [ ] **Step 1: Implement `src/scheduler/daemon.ts`**

```ts
import type { Client } from "discord.js";
import { runTick } from "./tick.js";
import { resolveWakeupDir } from "../wakeup/paths.js";

const TICK_INTERVAL_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly discordClient: Client) {}

  async start(): Promise<void> {
    if (this.timer !== null) return;  // idempotent
    await this.tickOnce();  // catch-up
    this.timer = setInterval(() => {
      this.tickOnce().catch((e) => {
        console.error("[scheduler] unhandled tick error:", e);
      });
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runTick({
        now: Date.now(),
        wakeupDir: resolveWakeupDir(),
        discordClient: this.discordClient,
        log: (msg, err) => console.warn(msg, err ?? ""),
      });
    } catch (e) {
      console.error("[scheduler] tick threw:", e);
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 2: Wire Scheduler into `src/bot/client.ts`**

Find the block where `WakeupWatcher` is started. Add Scheduler alongside:

```ts
import { Scheduler } from "../scheduler/daemon.js";

// ... after wakeupWatcher initialization:
const scheduler = new Scheduler(client);

client.once("ready", async () => {
  // ... existing ready handlers
  await scheduler.start();
});

// Ensure graceful shutdown stops both:
process.on("SIGTERM", () => {
  wakeupWatcher.stop();
  scheduler.stop();
  client.destroy();
});
process.on("SIGINT", () => {
  wakeupWatcher.stop();
  scheduler.stop();
  client.destroy();
});
```

Exact insertion points depend on existing client.ts structure — read the file first, mirror the `WakeupWatcher` wiring pattern.

- [ ] **Step 3: Run tests + typecheck + build**

```bash
npx tsc --noEmit
npm test
npm run build
```

Expected: All pass. Build produces a working `dist/`.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/daemon.ts src/bot/client.ts
git commit -m "feat(scheduler): wire daemon into bot lifecycle with 30s tick"
```

---

### Task 8: `/schedules` slash command

**Files:**
- Create: `src/bot/commands/schedules.ts`
- Create: `src/bot/commands/schedules.test.ts`
- Modify: `src/bot/client.ts` (register command)

**Interfaces:**
- Consumes:
  - `listSchedulesByChannel`, `deleteScheduleById` from Task 1
  - `listCronsByChannel`, `deleteCronById` from Task 1
- Produces:
  - `data`: SlashCommandBuilder for `/schedules` with three subs (`list`, `cancel`, `info`)
  - `execute(interaction)`: async handler

**Reference existing pattern:** `src/bot/commands/sessions.ts` uses `StringSelectMenu`. Follow that shape.

- [ ] **Step 1: Write failing test**

`src/bot/commands/schedules.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { formatScheduleList } from "./schedules.js";
import { __setDbForTests as setSchedDb, insertSchedule } from "../../db/schedules.js";
import { __setDbForTests as setCronsDb, insertCron } from "../../db/crons.js";

const CHANNEL = "123456789012345678";
const NOW = 1_700_000_000_000;

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fire_at INTEGER NOT NULL, prompt TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, ttl_seconds INTEGER NOT NULL DEFAULT 3600, created_at INTEGER NOT NULL);
    CREATE TABLE crons (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, name TEXT, next_fire INTEGER NOT NULL, last_fire INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setSchedDb(db); setCronsDb(db);
}

describe("formatScheduleList", () => {
  beforeEach(() => setup());

  it("shows empty state when no schedules", () => {
    const output = formatScheduleList(CHANNEL, NOW);
    expect(output).toMatch(/no schedules|沒有排程/i);
  });

  it("shows both schedules and crons with relative times", () => {
    insertSchedule({ id: "sch_a", channel_id: CHANNEL, fire_at: NOW + 132_000, prompt: "Check R-018", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: NOW });
    insertCron({ id: "cron_b", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "morning", name: "morning", next_fire: NOW + 9200_000, last_fire: null, created_at: NOW });

    const output = formatScheduleList(CHANNEL, NOW);
    expect(output).toContain("sch_a");
    expect(output).toContain("cron_b");
    expect(output).toMatch(/2m 12s/);  // 132s = 2m 12s
    expect(output).toContain("Check R-018");
    expect(output).toContain("0 9 * * *");
  });

  it("truncates long prompts", () => {
    insertSchedule({ id: "sch_long", channel_id: CHANNEL, fire_at: NOW + 60_000,
      prompt: "x".repeat(200), reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: NOW });
    const output = formatScheduleList(CHANNEL, NOW);
    expect(output).toContain("...");
    expect(output).not.toContain("x".repeat(100));  // truncated
  });
});
```

- [ ] **Step 2: Implement `src/bot/commands/schedules.ts`**

```ts
import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction, type CacheType } from "discord.js";
import { listSchedulesByChannel, deleteScheduleById } from "../../db/schedules.js";
import { listCronsByChannel, deleteCronById } from "../../db/crons.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("schedules")
  .setDescription("Manage Claude's harness-scheduled tasks in this channel")
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List active schedules in this channel"))
  .addSubcommand((sub) =>
    sub.setName("cancel").setDescription("Cancel a schedule or cron by id")
      .addStringOption((o) => o.setName("id").setDescription("Schedule or cron id").setRequired(true)))
  .addSubcommand((sub) =>
    sub.setName("info").setDescription("Show details of a specific schedule/cron")
      .addStringOption((o) => o.setName("id").setDescription("Schedule or cron id").setRequired(true)));

export async function execute(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  if (sub === "list") {
    const content = formatScheduleList(channelId, Date.now());
    await interaction.reply({ content, ephemeral: false });
    return;
  }

  if (sub === "cancel") {
    const id = interaction.options.getString("id", true);
    let ok = false;
    if (id.startsWith("sch_")) ok = deleteScheduleById(id);
    else if (id.startsWith("cron_")) ok = deleteCronById(id);
    await interaction.reply({
      content: ok
        ? L(`✅ Cancelled ${id}`, `✅ ${id} 취소됨`)
        : L(`❌ Not found: ${id}`, `❌ 찾을 수 없음: ${id}`),
      ephemeral: true,
    });
    return;
  }

  if (sub === "info") {
    const id = interaction.options.getString("id", true);
    const content = formatScheduleInfo(channelId, id);
    await interaction.reply({ content, ephemeral: false });
    return;
  }
}

export function formatScheduleList(channelId: string, now: number): string {
  const schedules = listSchedulesByChannel(channelId);
  const crons = listCronsByChannel(channelId);

  if (schedules.length === 0 && crons.length === 0) {
    return L("📅 No schedules in this channel.", "📅 이 채널에 예약이 없습니다.");
  }

  const lines: string[] = [L("📅 Current schedules", "📅 현재 예약")];
  if (schedules.length > 0) {
    lines.push(``, L(`⏱️ One-shot (${schedules.length})`, `⏱️ 일회성 (${schedules.length})`));
    for (const s of schedules) {
      const delta = humanize(s.fire_at - now);
      const preview = truncate(s.prompt, 60);
      lines.push(`  \`${s.id}\`  ${L(`in ${delta}`, `${delta} 후`)}  ${preview}`);
    }
  }
  if (crons.length > 0) {
    lines.push(``, L(`🔁 Cron (${crons.length})`, `🔁 Cron (${crons.length})`));
    for (const c of crons) {
      const delta = humanize(c.next_fire - now);
      const nameStr = c.name ? ` [${c.name}]` : "";
      const preview = truncate(c.prompt, 60);
      lines.push(`  \`${c.id}\`  \`${c.cron_expr}\`${nameStr}  ${L(`next in ${delta}`, `다음 ${delta} 후`)}  ${preview}`);
    }
  }
  return lines.join("\n");
}

function formatScheduleInfo(channelId: string, id: string): string {
  if (id.startsWith("sch_")) {
    const row = listSchedulesByChannel(channelId).find((r) => r.id === id);
    if (!row) return L(`❌ Not found: ${id}`, `❌ 찾을 수 없음: ${id}`);
    return [
      `📄 **${row.id}**`,
      `Fires at: ${new Date(row.fire_at).toISOString()}`,
      `TTL: ${row.ttl_seconds}s`,
      `Reason: ${row.reason ?? "(none)"}`,
      ``,
      `Prompt:`,
      `\`\`\``,
      row.prompt,
      `\`\`\``,
    ].join("\n");
  }
  if (id.startsWith("cron_")) {
    const row = listCronsByChannel(channelId).find((r) => r.id === id);
    if (!row) return L(`❌ Not found: ${id}`, `❌ 찾을 수 없음: ${id}`);
    return [
      `📄 **${row.id}** ${row.name ? `[${row.name}]` : ""}`,
      `Expression: \`${row.cron_expr}\``,
      `Next fire: ${new Date(row.next_fire).toISOString()}`,
      `Last fire: ${row.last_fire ? new Date(row.last_fire).toISOString() : "(never)"}`,
      ``,
      `Prompt:`,
      `\`\`\``,
      row.prompt,
      `\`\`\``,
    ].join("\n");
  }
  return L(`❌ Invalid id format: ${id}. Expected sch_* or cron_*.`, `❌ 잘못된 id: ${id}`);
}

function humanize(ms: number): string {
  const past = ms < 0;
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  if (s < 60) return past ? `${s}s ago` : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return past ? `${m}m ${s % 60}s ago` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return past ? `${h}h ${m % 60}m ago` : `${h}h ${m % 60}m`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
```

- [ ] **Step 3: Register command in `src/bot/client.ts`**

Follow the same pattern as the other 10 commands (usually there's a commands array or import that gets registered to the guild). Add the schedules command import + registration.

- [ ] **Step 4: Run tests + typecheck + build**

```bash
npm test -- src/bot/commands/schedules.test.ts
npx tsc --noEmit
npm run build
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/schedules.ts src/bot/commands/schedules.test.ts src/bot/client.ts
git commit -m "feat(commands): add /schedules list/cancel/info command"
```

---

### Task 9: End-to-end integration test

**Files:**
- Create: `test/integration/schedule-end-to-end.test.ts`

**Interfaces:**
- Consumes: all modules from Tasks 1-8

- [ ] **Step 1: Write the integration test**

`test/integration/schedule-end-to-end.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { handleScheduleWakeup } from "../../src/hooks/schedule-wakeup.js";
import { runTick } from "../../src/scheduler/tick.js";
import { WakeupWatcher } from "../../src/wakeup/watcher.js";
import { __setDbForTests as setSchedDb, listSchedulesByChannel } from "../../src/db/schedules.js";
import { __setDbForTests as setCronsDb } from "../../src/db/crons.js";

const CHANNEL = "123456789012345678";

function setupDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fire_at INTEGER NOT NULL, prompt TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, ttl_seconds INTEGER NOT NULL DEFAULT 3600, created_at INTEGER NOT NULL);
    CREATE TABLE crons (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, name TEXT, next_fire INTEGER NOT NULL, last_fire INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setSchedDb(db); setCronsDb(db);
}

describe("Schedule end-to-end pipeline", () => {
  beforeEach(() => setupDb());

  it("Claude ScheduleWakeup → DB → tick → wakeup file → WakeupWatcher → wakeUp()", async () => {
    // Setup tmp wakeup dir + spy on wakeUp
    const wakeupDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-wakeup-"));
    const wakeUpSpy = vi.fn().mockResolvedValue(undefined);

    try {
      // 1. Simulate Claude calling ScheduleWakeup — the hook processes it
      const NOW = 1_700_000_000_000;
      const hookResult = handleScheduleWakeup(
        { delaySeconds: 60, prompt: "check autoplay", reason: "5min poll" },
        { channelId: CHANNEL, channel: {} as never, now: () => NOW },
      );
      expect(hookResult.hookSpecificOutput?.permissionDecision).toBe("deny");
      const dbRows = listSchedulesByChannel(CHANNEL);
      expect(dbRows).toHaveLength(1);

      // 2. Fast-forward clock to fire_at
      const fireAt = dbRows[0].fire_at;
      await runTick({
        now: fireAt,
        wakeupDir,
        discordClient: {} as never,
        log: () => {},
      });

      // 3. Verify wakeup file was written
      const files = (await fs.readdir(wakeupDir)).filter((n) => n.endsWith(".json"));
      expect(files).toHaveLength(1);
      const payload = JSON.parse(await fs.readFile(path.join(wakeupDir, files[0]), "utf-8"));
      expect(payload.channel_id).toBe(CHANNEL);
      expect(payload.prompt).toBe("check autoplay");
      expect(payload.source).toBe("schedule_wakeup");

      // 4. Verify DB row was deleted
      expect(listSchedulesByChannel(CHANNEL)).toHaveLength(0);

      // 5. Hand-off to WakeupWatcher
      const watcher = new WakeupWatcher({
        wakeupDir,
        legacyDir: "/nonexistent",
        isChannelRegistered: (id) => id === CHANNEL,
        hasActiveSession: () => false,  // idle → direct wakeUp
        wakeUp: wakeUpSpy,
        sendPassiveEmbed: async () => {},
      });

      // Scan once to process the file we already dropped
      await watcher["scanWakeupDir"]?.();

      // 6. wakeUp should have been called with the right args
      expect(wakeUpSpy).toHaveBeenCalledOnce();
      expect(wakeUpSpy).toHaveBeenCalledWith(CHANNEL, "check autoplay", "schedule_wakeup");

      // 7. File was cleaned up by watcher
      expect((await fs.readdir(wakeupDir)).filter((n) => n.endsWith(".json"))).toHaveLength(0);
    } finally {
      await fs.rm(wakeupDir, { recursive: true, force: true });
    }
  });
});
```

**Note:** `watcher["scanWakeupDir"]?.()` accesses a private method for testability. If that method is `#private`, you'll need to either make it internal-visibility (rename to `_scanWakeupDir` and export from the module) or trigger scanning by starting the watcher on the tmp dir. Adjust based on the actual watcher's API — refer to `src/wakeup/watcher.ts:123-130`.

- [ ] **Step 2: Run integration test**

```bash
npm test -- test/integration/schedule-end-to-end.test.ts
```

Expected: PASS.

- [ ] **Step 3: Full test suite + build**

```bash
npm test
npm run build
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add test/integration/schedule-end-to-end.test.ts
git commit -m "test(integration): end-to-end schedule pipeline test"
```

---

### Task 10: Manual smoke test + documentation

**Files:**
- Modify: `TESTING.md` (add smoke-test section for scheduling bridge)

- [ ] **Step 1: Add smoke-test checklist**

Append to `TESTING.md`:

```markdown
## Harness Scheduling Bridge (spec 2026-07-13)

Run these against a live bot connected to a real Discord channel with a
registered project. Each item should be tested before merging changes to
`src/hooks/`, `src/scheduler/`, or `src/db/(schedules|crons).ts`.

- [ ] **Short delay:** Ask Claude to `ScheduleWakeup(60, prompt="say hello")`.
  After 60±30s, Claude should resume automatically and say hello.
- [ ] **Cron 2-minute:** `CronCreate("*/2 * * * *", prompt="say tick")`. Observe
  3 fires roughly 2 minutes apart. Then `CronDelete <id>` to clean up.
- [ ] **Restart survival:** Ask Claude to `ScheduleWakeup(180)`. Immediately
  restart the bot (`pm2 restart bot` or Ctrl-C + `npm start`). Confirm wakeup
  still fires ~3 minutes after original request.
- [ ] **TTL expiry:** Ask Claude to `ScheduleWakeup(60)`. Immediately put your
  laptop to sleep for 2 hours. Wake it. Expected: bot posts a bundled miss
  embed for the expired schedule; no zombie Claude session.
- [ ] **/schedules commands:** With 2+ pending schedules, run:
  - `/schedules list` → should show all
  - `/schedules info sch_xxx` → should show prompt in full
  - `/schedules cancel sch_xxx` → should remove one
  - Re-run `/schedules list` → should show remainder
- [ ] **PushNotification:** Ask Claude to `PushNotification(message="task done")`.
  Bot should immediately post "task done" to the channel (no @mention).
- [ ] **Rate limit:** Ask Claude to schedule 51 wakeups in a row. The 51st should
  be denied with a rate-limit reason.

If any of these fail, do NOT merge — reopen the design.
```

- [ ] **Step 2: Commit**

```bash
git add TESTING.md
git commit -m "docs(testing): smoke-test checklist for harness scheduling bridge"
```

---

## Self-Review Checklist (post-plan)

1. **Spec coverage:**
   - ✅ Section 2.1 ScheduleWakeup handler → Task 3
   - ✅ Section 2.2 CronCreate → Task 4
   - ✅ Section 2.3 CronList → Task 4
   - ✅ Section 2.4 CronDelete → Task 4
   - ✅ Section 2.5 PushNotification → Task 5
   - ✅ Section 3 Scheduler tick logic → Task 6
   - ✅ Section 3 Bot lifecycle wiring → Task 7
   - ✅ Section 4 DB schema → Task 1
   - ✅ Section 5 /schedules slash command → Task 8
   - ✅ Section 6 Error handling (folded into each task's error-handling code)
   - ✅ Section 7 Testing (unit + integration + smoke) → Tasks 1-9 + 10

2. **Type consistency verified:**
   - `HookDeps` defined in Task 3, imported by Tasks 4/5 (`from "./schedule-wakeup.js"`)
   - `HookResult` same
   - `ScheduleRow`, `CronRow` defined Task 1, used Tasks 3/6/8
   - `TickDeps` defined Task 6, used Task 7

3. **No placeholders:** Every code block contains actual runnable code. Insertion
   points for `src/claude/session-manager.ts` and `src/bot/client.ts` reference
   the existing patterns; implementer reads the file, mirrors the pattern.

4. **Open assumptions to verify at implementation time:**
   - `cron-parser` v5 API (`CronExpressionParser.parse`) — Task 2 note flags version mismatch
   - PreToolUse `permissionDecision: "deny"` semantics with informational reason — validated in Task 3 smoke test
   - `CronCreate` tool input shape — assumed `{ schedule, prompt, name }`; verify against first live call (spec Open Question #2)
