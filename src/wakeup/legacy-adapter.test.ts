import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizePayloadFromDoneFile, resolveChannelForSlot } from "./legacy-adapter.js";

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

  it("returns null when meta lacks channel_id AND no channel file exists AND no DB match", () => {
    // With all three fallback layers unavailable, we can't route the wakeup.
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

  // Regression tests for the "manual retry rewrites meta and loses
  // channel_id" bug (2026-09-14). Claude's ad-hoc `nohup codex exec` retry
  // truncates the meta file with `>`, dropping the `channel_id=` line that
  // SKILL.md's Step 3 wrote. Fix: SKILL.md ALSO writes a stable
  // /tmp/run-plan-channel-<slot>.txt that retries don't touch, and the
  // adapter falls back to it. As a last resort, adapter looks up the cwd
  // in the bot's projects table.

  it("falls back to /tmp/run-plan-channel-<slot>.txt when meta lacks channel_id", () => {
    const doneFile = path.join(tmp, "run-plan-done-retry-slot.txt");
    fs.writeFileSync(doneFile, "slot=retry-slot\nstatus=DONE\ncommits=+3\n");
    // Meta was rewritten by retry — lost channel_id
    const metaFile = path.join(tmp, "run-plan-meta-retry-slot.txt");
    fs.writeFileSync(metaFile, "plan=/p/foo.md\nbranch=main\ncwd=/some/unregistered/path\n");
    // But the stable channel file survives
    fs.writeFileSync(path.join(tmp, "run-plan-channel-retry-slot.txt"), "123456789012345678\n");

    const payload = synthesizePayloadFromDoneFile(doneFile, { metaDir: tmp });
    expect(payload).not.toBeNull();
    expect(payload!.channel_id).toBe("123456789012345678");
  });

  it("resolveChannelForSlot: meta channel_id wins over channel file", () => {
    fs.writeFileSync(path.join(tmp, "run-plan-channel-x.txt"), "999999999999999999");
    const meta = { channel_id: "123456789012345678", cwd: "/some" };
    expect(resolveChannelForSlot("x", meta, { channelFileDir: tmp })).toBe("123456789012345678");
  });

  it("resolveChannelForSlot: channel file wins over DB fallback", () => {
    fs.writeFileSync(path.join(tmp, "run-plan-channel-y.txt"), "123456789012345678");
    // Meta has cwd but no channel_id — channel file is the middle layer
    const meta = { cwd: "/some/path" };
    expect(resolveChannelForSlot("y", meta, { channelFileDir: tmp })).toBe("123456789012345678");
  });

  it("resolveChannelForSlot: returns null when all three layers empty", () => {
    // No channel_id, no channel file, no cwd → nothing to try
    expect(resolveChannelForSlot("z", {}, { channelFileDir: tmp })).toBeNull();
  });

  it("resolveChannelForSlot: DB fallback is graceful when DB not initialized", () => {
    // In this test context the DB isn't loaded; the DB fallback must not
    // throw — it must swallow the error and return null.
    const meta = { cwd: "/some/unregistered/path" };
    expect(() => resolveChannelForSlot("w", meta, { channelFileDir: tmp })).not.toThrow();
    expect(resolveChannelForSlot("w", meta, { channelFileDir: tmp })).toBeNull();
  });

  it("resolveChannelForSlot: ignores empty channel_id string in meta", () => {
    // SKILL.md's Step 3 writes `channel_id=${WAKEUP_CHANNEL_ID:-}` — when
    // env var unset, this becomes an empty value. Adapter must treat that
    // as "no channel_id" and continue to next fallback layer.
    fs.writeFileSync(path.join(tmp, "run-plan-channel-e.txt"), "123456789012345678");
    const meta = { channel_id: "", cwd: "/some" };
    expect(resolveChannelForSlot("e", meta, { channelFileDir: tmp })).toBe("123456789012345678");
  });
});
