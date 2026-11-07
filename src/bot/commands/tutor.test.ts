import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Tutor, Project } from "../../db/types.js";
import type { CronRow } from "../../db/crons.js";

vi.mock("../../db/database.js", () => ({ getProject: vi.fn(), setBackend: vi.fn(), clearSessionId: vi.fn() }));
vi.mock("../../db/tutors.js", () => ({ getTutor: vi.fn(), upsertTutor: vi.fn(), setTutorSession: vi.fn(), deleteTutor: vi.fn() }));
vi.mock("../../db/crons.js", () => ({ insertCron: vi.fn(), listCronsByChannel: vi.fn(), deleteCronById: vi.fn(), countCronsByChannel: vi.fn() }));
vi.mock("../../claude/session-manager.js", () => ({ sessionManager: { isActive: vi.fn(), sendMessage: vi.fn(async () => {}) } }));
vi.mock("../../utils/i18n.js", () => ({ L: (en: string) => en }));
import { getProject, setBackend, clearSessionId } from "../../db/database.js";
import { getTutor, upsertTutor, setTutorSession } from "../../db/tutors.js";
import { insertCron, listCronsByChannel, deleteCronById, countCronsByChannel } from "../../db/crons.js";
import { sessionManager } from "../../claude/session-manager.js";
import { data, execute, deleteTutorCrons } from "./tutor.js";

let storedTutor: Tutor | undefined;
let crons: CronRow[];
let project: Project;
const configuredTutor: Tutor = {
  channel_id: "ch", subject: "English", goal: "IELTS 7", level: null, deadline: null,
  daily_minutes: null, menu: null, push_time: "08:00", timezone: "Asia/Taipei", language: "zh",
  deeptutor_session_id: "s1", created_at: 0,
};
function cron(id: string, name: string, channel_id = "ch"): CronRow {
  return { id, name, channel_id, cron_expr: "0 0 * * *", prompt: "original", next_fire: 1_800_000_000_000, last_fire: null, created_at: 0 };
}
function interaction(sub = "setup", strings: Record<string, string | undefined> = {}, minutes: number | null = null) {
  return {
    channelId: "ch", channel: { id: "ch" },
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => ({ subject: "English", goal: "IELTS 7", ...strings })[name] ?? null,
      getInteger: () => minutes,
    },
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}
beforeEach(() => {
  vi.clearAllMocks();
  storedTutor = undefined;
  crons = [];
  project = { channel_id: "ch", project_path: "/p", guild_id: "g", auto_approve: 0, source_path: null, backend: "claude", created_at: "" };
  vi.mocked(getProject).mockImplementation(() => project);
  vi.mocked(setBackend).mockImplementation((_ch, backend) => { project = { ...project, backend }; });
  vi.mocked(getTutor).mockImplementation(() => storedTutor);
  vi.mocked(upsertTutor).mockImplementation(row => { storedTutor = { ...row, deeptutor_session_id: storedTutor?.deeptutor_session_id ?? null, created_at: storedTutor?.created_at ?? Date.now() }; });
  vi.mocked(listCronsByChannel).mockImplementation(ch => crons.filter(c => c.channel_id === ch));
  vi.mocked(countCronsByChannel).mockImplementation(ch => crons.filter(c => c.channel_id === ch).length);
  vi.mocked(deleteCronById).mockImplementation(id => { const old = crons.length; crons = crons.filter(c => c.id !== id); return old !== crons.length; });
  vi.mocked(insertCron).mockImplementation(row => { crons.push(row); });
  vi.mocked(sessionManager.isActive).mockReturnValue(false);
});
function expectNoWrites() {
  for (const fn of [upsertTutor, setBackend, clearSessionId, insertCron, deleteCronById, sessionManager.sendMessage]) expect(fn).not.toHaveBeenCalled();
}

describe("/tutor", () => {
  it("setup on unregistered channel replies with /register hint and writes nothing", async () => {
    vi.mocked(getProject).mockReturnValue(undefined);
    const inter = interaction();
    await execute(inter);
    expect(inter.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("/register") }));
    expectNoWrites();
  });
  it("setup creates tutor, switches backend, schedules daily and weekly UTC pushes, and sends intake", async () => {
    const inter = interaction();
    await execute(inter);
    expect(storedTutor).toMatchObject({ subject: "English", goal: "IELTS 7", push_time: "08:00", timezone: "Asia/Taipei", language: "zh" });
    expect(clearSessionId).toHaveBeenCalledWith("ch");
    expect(setBackend).toHaveBeenCalledWith("ch", "deeptutor");
    expect(crons).toEqual([
      expect.objectContaining({ name: "tutor:daily", cron_expr: "0 0 * * *", channel_id: "ch", prompt: expect.stringContaining("mastery_status") }),
      expect.objectContaining({ name: "tutor:weekly", cron_expr: "0 0 * * 0", channel_id: "ch", prompt: expect.stringContaining("粗估") }),
    ]);
    expect(crons.every(c => c.next_fire > Date.now() && c.last_fire === null)).toBe(true);
    expect(sessionManager.sendMessage).toHaveBeenCalledWith(inter.channel, expect.stringContaining("mastery_profile"));
    expect(inter.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });
  it("setup is idempotent", async () => {
    storedTutor = { ...configuredTutor };
    project.backend = "deeptutor";
    crons = [cron("d", "tutor:daily"), cron("w", "tutor:weekly"), cron("other", "other"), cron("foreign", "tutor:daily", "other-channel")];
    await execute(interaction());
    expect(vi.mocked(deleteCronById).mock.calls.map(c => c[0])).toEqual(["d", "w"]);
    expect(insertCron).toHaveBeenCalledTimes(2);
    await execute(interaction());
    expect(crons.filter(c => c.channel_id === "ch" && c.name === "tutor:daily")).toHaveLength(1);
    expect(crons.filter(c => c.channel_id === "ch" && c.name === "tutor:weekly")).toHaveLength(1);
    expect(crons).toContainEqual(cron("other", "other"));
    expect(crons).toContainEqual(cron("foreign", "tutor:daily", "other-channel"));
    expect(storedTutor.deeptutor_session_id).toBe("s1");
    expect(sessionManager.sendMessage).not.toHaveBeenCalled();
    expect(setBackend).not.toHaveBeenCalled();
  });
  it.each([{ time: "25:00" }, { timezone: "Mars/Base" }])("setup with invalid time/timezone replies with error and writes nothing: %j", async strings => {
    const inter = interaction("setup", strings);
    await execute(inter);
    expect(inter.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/invalid/i) }));
    expectNoWrites();
  });
  it("setup requires an idle channel", async () => {
    vi.mocked(sessionManager.isActive).mockReturnValue(true);
    const inter = interaction();
    await execute(inter);
    expect(inter.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("/stop") }));
    expectNoWrites();
  });
  it("setup refuses to exceed fifty crons", async () => {
    crons = Array.from({ length: 49 }, (_, i) => cron(`other-${i}`, "other"));
    await execute(interaction());
    expectNoWrites();
  });
  it("setup replaces tutor crons when already at the cron limit", async () => {
    crons = [cron("d", "tutor:daily"), cron("w", "tutor:weekly"), ...Array.from({ length: 48 }, (_, i) => cron(`other-${i}`, "other"))];
    await execute(interaction());
    expect(crons).toHaveLength(50);
    expect(insertCron).toHaveBeenCalledTimes(2);
  });
  it("deleteTutorCrons deletes only tutor:* rows and returns the count", () => {
    crons = [cron("d", "tutor:daily"), cron("w", "tutor:weekly"), cron("other", "tutor:custom"), cron("foreign", "tutor:daily", "other-channel")];
    expect(deleteTutorCrons("ch")).toBe(2);
    expect(crons.map(c => c.id)).toEqual(["other", "foreign"]);
    expect(deleteTutorCrons("ch")).toBe(0);
  });
  it("pause deletes only tutor crons", async () => {
    crons = [cron("d", "tutor:daily"), cron("w", "tutor:weekly"), cron("other", "tutor:custom"), cron("foreign", "tutor:daily", "other-channel")];
    await execute(interaction("pause"));
    expect(vi.mocked(deleteCronById).mock.calls.map(c => c[0])).toEqual(["d", "w"]);
    expect(crons.map(c => c.id)).toEqual(["other", "foreign"]);
  });
  it("reset clears the DeepTutor session id", async () => {
    storedTutor = { ...configuredTutor };
    await execute(interaction("reset"));
    expect(setTutorSession).toHaveBeenCalledWith("ch", null);
    expect(clearSessionId).not.toHaveBeenCalled();
  });
  it("reset refuses an active turn so a late session event cannot undo it", async () => {
    storedTutor = { ...configuredTutor, deeptutor_session_id: null };
    vi.mocked(sessionManager.isActive).mockReturnValue(true);
    const inter = interaction("reset");
    await execute(inter);
    expect(inter.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("/stop") }));
    expect(setTutorSession).not.toHaveBeenCalled();
  });
  it("show displays config and next fire times", async () => {
    storedTutor = { ...configuredTutor, level: "B1", deadline: "2027-01-01", daily_minutes: 20, menu: "grammar" };
    crons = [cron("d", "tutor:daily"), cron("w", "tutor:weekly")];
    const inter = interaction("show");
    await execute(inter);
    const payload = JSON.stringify(vi.mocked(inter.editReply).mock.calls[0][0]);
    for (const text of ["English", "IELTS 7", "B1", "2027-01-01", "20", "grammar", "Asia/Taipei", "tutor:daily", "tutor:weekly", "1800000000"]) expect(payload).toContain(text);
  });
  it("show reports no tutor", async () => {
    const inter = interaction("show");
    await execute(inter);
    expect(inter.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("/tutor setup") }));
  });
  it("registers the four subcommands and study-time bounds", () => {
    const schema = data.toJSON();
    expect(schema.options?.map(option => option.name)).toEqual(["setup", "show", "pause", "reset"]);
    const setup = schema.options?.[0];
    if (setup?.type !== 1) throw new Error("missing setup subcommand");
    expect(setup.options?.find(option => option.name === "daily_minutes")).toMatchObject({ min_value: 5, max_value: 120 });
  });
});
