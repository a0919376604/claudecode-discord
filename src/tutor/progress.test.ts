import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatProgressMap, masteryDbPath, readMasteryState } from "./progress.js";

const NOW = 1_800_000_000_000;
const state = {
  name: "JLPT N5",
  modules: [
    { name: "Hiragana", knowledge_points: [
      { id: "k0", name: "Seion", type: "memory" },
      { id: "k1", name: "Dakuon", type: "memory" },
    ] },
    { name: "Grammar", knowledge_points: [
      { id: "k2", name: "wa / desu", type: "concept" },
      { id: "k3", name: "Particles", type: "procedure" },
    ] },
  ],
  mastery_levels: { k0: 0.95, k1: 0.4, k3: 0.2 },
  qualitative_mastery: { k2: true },
  learner_mastery_overrides: {},
  review_queue: [{ knowledge_point_id: "k0", due_at: NOW / 1000 - 60 }, { knowledge_point_id: "k1", due_at: NOW / 1000 + 3600 }],
};

describe("formatProgressMap", () => {
  it("renders per-module counts, bars and percentages with the 90% gate", () => {
    const map = formatProgressMap(state, NOW)!;
    expect(map).toContain("JLPT N5");
    expect(map).toContain("Hiragana  1/2");
    expect(map).toContain("Grammar  1/2");
    expect(map).toMatch(/✅ █{9}░ +95% Seion/);
    expect(map).toMatch(/▶️ █{4}░{6} +40% Dakuon/);
    expect(map).toMatch(/✅ █{10} +100% wa \/ desu/);
    expect(map).toMatch(/▶️ █{2}░{8} +20% Particles/);
  });
  it("summarises overall progress and due reviews", () => {
    const map = formatProgressMap(state, NOW)!;
    expect(map).toContain("Mastered 2/4");
    expect(map).toContain("Due reviews: 1");
  });
  it("returns null for a path with no outline yet", () => {
    expect(formatProgressMap({ name: "x", modules: [] }, NOW)).toBeNull();
    expect(formatProgressMap(null, NOW)).toBeNull();
  });
});

describe("readMasteryState", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("reads a path's state_json from DeepTutor's mastery store, read-only", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-home-"));
    const file = masteryDbPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec("CREATE TABLE mastery_paths (path_id TEXT PRIMARY KEY, state_json TEXT)");
    db.prepare("INSERT INTO mastery_paths VALUES (?, ?)").run("p1", JSON.stringify(state));
    db.close();
    expect(readMasteryState(dir, "p1")).toMatchObject({ name: "JLPT N5" });
    expect(readMasteryState(dir, "missing")).toBeNull();
  });
  it("returns null when DeepTutor has no mastery store", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-home-"));
    expect(readMasteryState(dir, "p1")).toBeNull();
  });
});
