import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { ButtonInteraction } from "discord.js";
import type { Project } from "../../db/types.js";

vi.mock("../../security/guard.js", () => ({ isAllowedUser: () => true }));
vi.mock("../../claude/session-manager.js", () => ({ sessionManager: {} }));
vi.mock("../../db/database.js", () => ({ getProject: vi.fn(), clearSessionId: vi.fn(), setBackend: vi.fn() }));
vi.mock("../../agent/codex-detect.js", () => ({ detectCodex: vi.fn(async () => ({ ok: true, errorMessage: "" })) }));
vi.mock("../../utils/i18n.js", () => ({ L: (en: string) => en }));
import { getProject, setBackend } from "../../db/database.js";
import { __setDbForTests as setCronsDb, insertCron, listCronsByChannel } from "../../db/crons.js";
import { __setDbForTests as setTutorsDb, getTutor, setTutorSession, upsertTutor } from "../../db/tutors.js";
import { handleButtonInteraction } from "./interaction.js";

let db: Database.Database;
let project: Project;
function button(target: string, decision = "yes") {
  return { customId: `switch-${target}-ch-${decision}`, channelId: "ch", user: { id: "user" }, update: vi.fn() };
}
beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tutors (
      channel_id TEXT PRIMARY KEY, subject TEXT, goal TEXT, level TEXT, deadline TEXT,
      daily_minutes INTEGER, menu TEXT, push_time TEXT, timezone TEXT, language TEXT,
      deeptutor_session_id TEXT, created_at INTEGER
    );
    CREATE TABLE crons (
      id TEXT PRIMARY KEY, channel_id TEXT, cron_expr TEXT, prompt TEXT, name TEXT,
      next_fire INTEGER, last_fire INTEGER, created_at INTEGER
    );
  `);
  setCronsDb(db);
  setTutorsDb(db);
  project = { channel_id: "ch", project_path: "/p", guild_id: "g", backend: "deeptutor", auto_approve: 0, source_path: null, created_at: "" };
  vi.mocked(getProject).mockImplementation(() => project);
  vi.mocked(setBackend).mockImplementation((_channelId, backend) => { project = { ...project, backend }; });
  upsertTutor({ channel_id: "ch", subject: "English", goal: "IELTS 7", level: null, deadline: null, daily_minutes: null, menu: null, push_time: "08:00", timezone: "Asia/Taipei", language: "zh" });
  setTutorSession("ch", "saved-learning-path");
  for (const [id, name, channel_id] of [
    ["d", "tutor:daily", "ch"], ["w", "tutor:weekly", "ch"],
    ["other", "custom", "ch"], ["foreign", "tutor:daily", "other-channel"],
  ]) insertCron({ id, name, channel_id, cron_expr: "0 0 * * *", prompt: "lesson", next_fire: 1, last_fire: null, created_at: 0 });
});
afterEach(() => { setCronsDb(null); setTutorsDb(null); db.close(); });

describe("backend switch confirmation", () => {
  it.each(["claude", "codex"])("confirming /%s on a deeptutor channel deletes tutor crons and keeps the tutor row", async target => {
    const tutor = getTutor("ch");
    const inter = button(target);
    await handleButtonInteraction(inter as unknown as ButtonInteraction);
    expect(project.backend).toBe(target);
    expect(listCronsByChannel("ch").map(c => c.id)).toEqual(["other"]);
    expect(listCronsByChannel("other-channel").map(c => c.id)).toEqual(["foreign"]);
    expect(getTutor("ch")).toEqual(tutor);
    expect(inter.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/pushes paused.*\/tutor setup/i) }));
  });
  it("confirming /codex on a claude channel does not touch crons", async () => {
    project.backend = "claude";
    const crons = listCronsByChannel("ch");
    const inter = button("codex");
    await handleButtonInteraction(inter as unknown as ButtonInteraction);
    expect(project.backend).toBe("codex");
    expect(listCronsByChannel("ch")).toEqual(crons);
    expect(inter.update).toHaveBeenCalledWith({ content: "✅ Switched to Codex. Next message will start a fresh session.", components: [] });
  });
  it("cancelling a switch keeps tutor pushes active", async () => {
    const crons = listCronsByChannel("ch");
    await handleButtonInteraction(button("claude", "no") as unknown as ButtonInteraction);
    expect(project.backend).toBe("deeptutor");
    expect(listCronsByChannel("ch")).toEqual(crons);
  });
});
