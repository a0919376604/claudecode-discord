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
