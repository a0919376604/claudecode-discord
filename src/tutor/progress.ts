import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { L } from "../utils/i18n.js";

/** DeepTutor's mastery store under its runtime home (DEEPTUTOR_HOME). */
export function masteryDbPath(home: string): string {
  return path.join(home, "data", "user", "workspace", "learning", "mastery", "mastery.sqlite3");
}

/** A mastery path's state_json (path id = the tutor's DeepTutor session id), or null. Read-only. */
export function readMasteryState(home: string, pathId: string): unknown | null {
  const file = masteryDbPath(home);
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT state_json FROM mastery_paths WHERE path_id = ?").get(pathId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) : null;
  } finally {
    db.close();
  }
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const GATE = 0.9;
const QUALITATIVE = new Set(["concept", "design"]);

// ponytail: mirrors DeepTutor's policy.display_mastery / gate (0.9, qualitative pass, learner override)
// without its visual-task requirements; read DeepTutor's own status if those ever matter here.
function kpStatus(state: Rec, kp: Rec): { pct: number; mastered: boolean; touched: boolean } {
  const id = String(kp.id);
  const level = Number(rec(state.mastery_levels)[id] ?? 0);
  const qualitativePass = QUALITATIVE.has(String(kp.type)) && rec(state.qualitative_mastery)[id] === true;
  const pct = qualitativePass ? 1 : level;
  const mastered = qualitativePass || (!QUALITATIVE.has(String(kp.type)) && level >= GATE) || id in rec(state.learner_mastery_overrides);
  return { pct, mastered, touched: id in rec(state.mastery_levels) || id in rec(state.qualitative_mastery) };
}

const bar = (pct: number) => { const n = Math.max(0, Math.min(10, Math.floor(pct * 10))); return "█".repeat(n) + "░".repeat(10 - n); };

/** Plain-text progress map (fits a Discord code block), or null when the path has no outline yet. */
export function formatProgressMap(state: unknown, now: number = Date.now()): string | null {
  const s = rec(state);
  const modules = arr(s.modules).map(rec).filter(m => arr(m.knowledge_points).length);
  if (!modules.length) return null;
  let mastered = 0;
  let total = 0;
  const lines: string[] = [];
  for (const m of modules) {
    const kps = arr(m.knowledge_points).map(rec);
    const rows = kps.map(kp => ({ kp, ...kpStatus(s, kp) }));
    const done = rows.filter(r => r.mastered).length;
    mastered += done;
    total += rows.length;
    lines.push(`${m.name}  ${done}/${rows.length}`);
    for (const r of rows) {
      const icon = r.mastered ? "✅" : r.touched ? "▶️" : "· ";
      lines.push(`  ${icon} ${bar(r.pct)} ${String(Math.round(r.pct * 100)).padStart(3)}% ${r.kp.name}`);
    }
  }
  const due = arr(s.review_queue).map(rec).filter(r => Number(r.due_at) * 1000 <= now).length;
  return [
    `${s.name ?? ""}`.trim(),
    `${L("Mastered", "숙달")} ${mastered}/${total} · ${L("Due reviews", "복습 예정")}: ${due}`,
    "",
    ...lines,
  ].filter((line, i) => i > 0 || line).join("\n");
}
