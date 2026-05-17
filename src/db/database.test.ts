import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock better-sqlite3 to always use :memory:
vi.mock("better-sqlite3", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await vi.importActual("better-sqlite3") as any;
  const RealDatabase = actual.default;
  return {
    default: function MemoryDatabase(_path: string, options?: object) {
      return new RealDatabase(":memory:", options);
    },
  };
});

import {
  initDatabase,
  registerProject,
  registerWorktreeProject,
  unregisterProject,
  getProject,
  getAllProjects,
  setAutoApprove,
  upsertSession,
  getSession,
  updateSessionStatus,
  getAllSessions,
  clearSessionId,
} from "./database.js";

describe("database", () => {
  beforeEach(() => {
    initDatabase();
  });

  // ─── Project CRUD ───

  describe("project CRUD", () => {
    it("registerProject + getProject", () => {
      registerProject("ch1", "/path/to/project", "guild1");
      const project = getProject("ch1");
      expect(project).toBeDefined();
      expect(project!.project_path).toBe("/path/to/project");
      expect(project!.guild_id).toBe("guild1");
      expect(project!.auto_approve).toBe(0);
    });

    it("registerProject with same channelId replaces existing", () => {
      registerProject("ch1", "/old/path", "guild1");
      registerProject("ch1", "/new/path", "guild1");
      const project = getProject("ch1");
      expect(project!.project_path).toBe("/new/path");
    });

    it("getProject returns undefined for non-existent channel", () => {
      expect(getProject("nonexistent")).toBeUndefined();
    });

    it("getAllProjects filters by guild", () => {
      registerProject("ch1", "/p1", "guild1");
      registerProject("ch2", "/p2", "guild1");
      registerProject("ch3", "/p3", "guild2");
      expect(getAllProjects("guild1")).toHaveLength(2);
      expect(getAllProjects("guild2")).toHaveLength(1);
      expect(getAllProjects("guild3")).toHaveLength(0);
    });

    it("unregisterProject removes project and cascades to sessions", () => {
      registerProject("ch1", "/p1", "guild1");
      upsertSession("s1", "ch1", null, "online");
      unregisterProject("ch1");
      expect(getProject("ch1")).toBeUndefined();
      expect(getSession("ch1")).toBeUndefined();
    });

    it("setAutoApprove toggles auto_approve flag", () => {
      registerProject("ch1", "/p1", "guild1");
      expect(getProject("ch1")!.auto_approve).toBe(0);

      setAutoApprove("ch1", true);
      expect(getProject("ch1")!.auto_approve).toBe(1);

      setAutoApprove("ch1", false);
      expect(getProject("ch1")!.auto_approve).toBe(0);
    });

    it("registerProject sets source_path to NULL by default", () => {
      registerProject("ch1", "/p1", "guild1");
      const project = getProject("ch1");
      expect(project!.source_path).toBeNull();
    });

    it("registerWorktreeProject stores source_path", () => {
      registerWorktreeProject("ch1", "/wt/path", "guild1", "/src/path");
      const project = getProject("ch1");
      expect(project!.project_path).toBe("/wt/path");
      expect(project!.source_path).toBe("/src/path");
    });
  });

  // ─── Session CRUD ───

  describe("session CRUD", () => {
    beforeEach(() => {
      registerProject("ch1", "/p1", "guild1");
    });

    it("upsertSession + getSession", () => {
      upsertSession("s1", "ch1", "sdk-session-1", "online");
      const session = getSession("ch1");
      expect(session).toBeDefined();
      expect(session!.session_id).toBe("sdk-session-1");
      expect(session!.status).toBe("online");
    });

    it("upsertSession replaces existing session with same id", () => {
      upsertSession("s1", "ch1", null, "online");
      upsertSession("s1", "ch1", "sdk-1", "idle");
      const session = getSession("ch1");
      expect(session!.session_id).toBe("sdk-1");
      expect(session!.status).toBe("idle");
    });

    it("upsertSession with null sessionId", () => {
      upsertSession("s1", "ch1", null, "online");
      const session = getSession("ch1");
      expect(session!.session_id).toBeNull();
    });

    it("updateSessionStatus changes status", () => {
      upsertSession("s1", "ch1", null, "online");
      updateSessionStatus("ch1", "waiting");
      expect(getSession("ch1")!.status).toBe("waiting");
    });

    it("getAllSessions joins with projects", () => {
      registerProject("ch2", "/p2", "guild1");
      upsertSession("s1", "ch1", null, "online");
      upsertSession("s2", "ch2", null, "idle");
      const sessions = getAllSessions("guild1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].project_path).toBeDefined();
    });

    it("getAllSessions returns empty for guild with no sessions", () => {
      registerProject("ch2", "/p2", "guild2");
      expect(getAllSessions("guild2")).toHaveLength(0);
    });

    it("clearSessionId sets session_id to NULL for the right channel", () => {
      registerProject("ch2", "/p2", "guild1");
      upsertSession("s1", "ch1", "sdk-session-1", "online");
      upsertSession("s2", "ch2", "sdk-session-2", "online");

      clearSessionId("ch1");

      expect(getSession("ch1")!.session_id).toBeNull();
      expect(getSession("ch2")!.session_id).toBe("sdk-session-2");
    });

    it("clearSessionId on unknown channel is a no-op", () => {
      expect(() => clearSessionId("missing")).not.toThrow();
    });

    it("clearSessionId preserves the existing session row fields", () => {
      upsertSession("s1", "ch1", "sdk-session-1", "waiting");

      clearSessionId("ch1");

      const session = getSession("ch1");
      expect(session).toBeDefined();
      expect(session!.id).toBe("s1");
      expect(session!.channel_id).toBe("ch1");
      expect(session!.session_id).toBeNull();
      expect(session!.status).toBe("waiting");
      expect(session!.last_activity).toBeTruthy();
    });
  });
});

describe("source_path migration", () => {
  it("ALTER TABLE adds source_path when missing", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (
        channel_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        auto_approve INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const before = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === "source_path")).toBe(false);

    // Mirror the migration block from initDatabase().
    const cols = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "source_path")) {
      db.exec("ALTER TABLE projects ADD COLUMN source_path TEXT");
    }

    const after = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === "source_path")).toBe(true);
  });
});
