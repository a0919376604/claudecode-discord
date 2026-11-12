import type { Tutor } from "../db/types.js";

export function buildIntakePrompt(t: Tutor): string {
  return [
    `You are my ${t.subject} tutor. My goal is: ${t.goal}.`,
    t.level ? `Current level: ${t.level}.` : "",
    t.deadline ? `Deadline: ${t.deadline}.` : "",
    t.daily_minutes !== null ? `Daily study time: ${t.daily_minutes} minutes.` : "",
    t.menu ? `Menu preferences: ${t.menu}.` : "",
    "Record this learner information with mastery_profile, and also record teaching_strategy teach_first plus these preferences: after each graded answer explain briefly why; end every lesson with a short summary of what was covered and what to review.",
    "Design the learning outline with mastery_build, shaped by the menu preferences.",
    "Then run a placement check: 3-5 questions with mastery_quiz across the outline, one at a time, to find my real level; adjust the outline from the results and finish with a short summary of my level.",
    "Keep it mobile-friendly; do not use ask_user. Ask any clarification as plain text and wait for my next message.",
  ].filter(Boolean).join("\n");
}

export function buildDailyPrompt(t: Tutor): string {
  return [
    `Prepare today's ${t.subject} lesson toward my goal: ${t.goal}. Call mastery_status first.`,
    "Prioritize due reviews and weak points; also advance at least one step toward the next goal objective.",
    "Teach first: open with a short lesson on today's point, then check it with a question or a small game, and after the last answer give a short summary of today and what to review next time.",
    "If stuck on one weak point for days, change the teaching approach or use mastery_defer_objective and return to it later.",
    `Keep it to about ${t.daily_minutes ?? 15} minutes and mobile-friendly.`,
    `The menu is a preference, not a fixed list: ${t.menu ?? "choose what best supports my goal"}.`,
    "End with one question via mastery_quiz; do not use ask_user. Ask clarification as plain text and wait for my next message.",
  ].join("\n");
}

export function buildWeeklyPrompt(t: Tutor): string {
  return [
    `Give a short mixed quiz of this week's ${t.subject} material and a progress report toward my goal: ${t.goal}.`,
    "Explicitly label any score estimate as a rough estimate (粗估). Keep it mobile-friendly.",
    "Use mastery_quiz for questions; do not use ask_user. Ask clarification as plain text and wait for my next message.",
  ].join("\n");
}
