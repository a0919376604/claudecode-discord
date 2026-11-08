import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { __setDbForTests, deleteTutor, getTutor, setTutorSession, upsertTutor } from "./tutors.js";

const tutor = {
  channel_id: "ch1", subject: "English", goal: "IELTS 7",
  level: "B1", deadline: "2027-01-01", daily_minutes: 20,
  menu: "Vocabulary and grammar", push_time: "08:00", timezone: "Asia/Taipei", language: "zh",
};
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('ch1');
    CREATE TABLE tutors (
      channel_id TEXT PRIMARY KEY REFERENCES projects(channel_id) ON DELETE CASCADE,
      subject TEXT NOT NULL, goal TEXT NOT NULL, level TEXT, deadline TEXT,
      daily_minutes INTEGER, menu TEXT, push_time TEXT NOT NULL,
      timezone TEXT NOT NULL, language TEXT NOT NULL, deeptutor_session_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  __setDbForTests(db);
});
afterEach(() => { __setDbForTests(null); db.close(); });

describe("tutors", () => {
  it("upsertTutor then getTutor round-trips all fields; deeptutor_session_id is null", () => {
    upsertTutor(tutor);
    expect(getTutor("ch1")).toEqual({ ...tutor, deeptutor_session_id: null, created_at: expect.any(Number) });
  });
  it("upsertTutor on existing row keeps deeptutor_session_id and created_at", () => {
    upsertTutor(tutor);
    const created = getTutor("ch1")!.created_at;
    setTutorSession("ch1", "s-1");
    upsertTutor({ ...tutor, goal: "IELTS 8" });
    expect(getTutor("ch1")).toMatchObject({ goal: "IELTS 8", deeptutor_session_id: "s-1", created_at: created });
  });
  it("setTutorSession(ch, null) clears the id", () => {
    upsertTutor(tutor);
    setTutorSession("ch1", "s-1");
    setTutorSession("ch1", null);
    expect(getTutor("ch1")!.deeptutor_session_id).toBeNull();
  });
  it("deleteTutor removes the row", () => {
    upsertTutor(tutor);
    deleteTutor("ch1");
    expect(getTutor("ch1")).toBeUndefined();
  });
  it("getTutor missing returns undefined", () => {
    expect(getTutor("missing")).toBeUndefined();
  });
});
