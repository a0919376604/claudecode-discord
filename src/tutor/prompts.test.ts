import { describe, expect, it } from "vitest";
import type { Tutor } from "../db/types.js";
import { buildDailyPrompt, buildIntakePrompt, buildWeeklyPrompt } from "./prompts.js";

const tutor: Tutor = {
  channel_id: "ch", subject: "English", goal: "IELTS 7", level: "B1", deadline: "2027-01-01",
  daily_minutes: 20, menu: "Vocabulary and grammar", push_time: "08:00", timezone: "Asia/Taipei",
  language: "zh", deeptutor_session_id: null, created_at: 0,
};
describe("tutor prompts", () => {
  it("intake records profile, builds an outline and starts placement without ask_user", () => {
    const prompt = buildIntakePrompt(tutor);
    for (const text of ["English", "IELTS 7", "B1", "2027-01-01", "20", "Vocabulary and grammar", "mastery_profile", "mastery_build", "placement", "do not use ask_user", "plain text", "next message"]) {
      expect(prompt).toContain(text);
    }
  });
  it("daily combines review with progress toward the next goal objective", () => {
    const prompt = buildDailyPrompt(tutor);
    for (const text of ["mastery_status", "mastery_quiz", "advance at least one step toward the next goal objective", "mastery_defer_objective", "20 minutes", "mobile-friendly", "preference", "do not use ask_user"]) {
      expect(prompt).toContain(text);
    }
  });
  it("daily defaults to fifteen minutes", () => {
    expect(buildDailyPrompt({ ...tutor, daily_minutes: null })).toContain("15 minutes");
  });
  it("weekly reports goal progress and labels score estimates as rough", () => {
    const prompt = buildWeeklyPrompt(tutor);
    for (const text of ["IELTS 7", "粗估", "mixed quiz", "this week's", "do not use ask_user"]) expect(prompt).toContain(text);
  });
});
