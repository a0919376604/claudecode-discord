import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractCodexSlot, handleBashLaunch } from "./bash-launch.js";
import type { HookDeps } from "./schedule-wakeup.js";

const upsertMock = vi.fn();

vi.mock("../db/database.js", () => ({
  upsertRunPlanSlot: (...args: unknown[]) => upsertMock(...args),
}));

const stubDeps = (channelId = "1505079292487274537"): HookDeps => ({
  channelId,
  // The bash-launch handler doesn't read `channel` (only `channelId` and `now`),
  // so a bare stand-in is enough — cast intentionally to avoid pulling in a
  // real Discord.js TextChannel in a unit test.
  channel: {} as HookDeps["channel"],
  now: () => 1_700_000_000_000,
});

describe("extractCodexSlot", () => {
  it("matches the canonical Step-3 launch pattern", () => {
    const cmd = "nohup codex exec - --dangerously-bypass-approvals-and-sandbox < /tmp/run-plan-prompt-R-184-impl-plan.txt > /tmp/run-plan-codex-R-184-impl-plan.log 2>&1 &";
    expect(extractCodexSlot(cmd)).toBe("R-184-impl-plan");
  });

  it("matches Claude's ad-hoc retry pattern with numeric run suffix", () => {
    const cmd = "nohup codex exec - < /tmp/prompt.txt > /tmp/run-plan-codex-R-184-impl-plan.log.run4 2>&1 &";
    expect(extractCodexSlot(cmd)).toBe("R-184-impl-plan");
  });

  it("matches slots containing dots (e.g. 'R-180.3-slice-c')", () => {
    const cmd = "codex exec - < /tmp/p.txt > /tmp/run-plan-codex-R-180.3-slice-c-admin-api-ui_.log 2>&1";
    expect(extractCodexSlot(cmd)).toBe("R-180.3-slice-c-admin-api-ui_");
  });

  it("matches slots with a trailing underscore (real slot format)", () => {
    // Observed in prod: /tmp/run-plan-meta-R-112-polish_.txt
    const cmd = "nohup codex exec > /tmp/run-plan-codex-R-112-polish_.log 2>&1 &";
    expect(extractCodexSlot(cmd)).toBe("R-112-polish_");
  });

  it("matches double-quoted paths", () => {
    const cmd = 'codex exec > "/tmp/run-plan-codex-slot-x.log" 2>&1';
    expect(extractCodexSlot(cmd)).toBe("slot-x");
  });

  it("matches single-quoted paths", () => {
    const cmd = "codex exec > '/tmp/run-plan-codex-slot-y.log.run2' 2>&1";
    expect(extractCodexSlot(cmd)).toBe("slot-y");
  });

  it("returns null when the command has no codex log path", () => {
    expect(extractCodexSlot("ls -la /tmp")).toBeNull();
    expect(extractCodexSlot("git commit -m 'wip'")).toBeNull();
  });

  it("returns null when 'codex' appears without a run-plan-codex log path", () => {
    // Bare `codex login` etc. — nothing to record.
    expect(extractCodexSlot("codex login")).toBeNull();
    expect(extractCodexSlot("cat /tmp/some-codex-notes.txt")).toBeNull();
  });

  it("does not match unrelated /tmp files whose names contain 'run-plan'", () => {
    // We anchor on `/tmp/run-plan-codex-<slot>.log` specifically to avoid
    // false positives on other run-plan companion files.
    expect(extractCodexSlot("cat /tmp/run-plan-meta-R-x.txt")).toBeNull();
    expect(extractCodexSlot("cat /tmp/run-plan-cwd-R-x.txt")).toBeNull();
    expect(extractCodexSlot("cat /tmp/run-plan-prompt-R-x.txt")).toBeNull();
    expect(extractCodexSlot("cat /tmp/run-plan-done-R-x.txt")).toBeNull();
  });
});

describe("handleBashLaunch", () => {
  beforeEach(() => {
    upsertMock.mockReset();
  });

  it("records slot when command matches codex launch pattern", () => {
    const result = handleBashLaunch(
      { command: "nohup codex exec > /tmp/run-plan-codex-R-184.log 2>&1 &" },
      stubDeps(),
    );
    expect(result).toEqual({ continue: true });
    expect(upsertMock).toHaveBeenCalledWith("R-184", "1505079292487274537", 1_700_000_000_000);
  });

  it("does NOT record for unrelated Bash commands", () => {
    const result = handleBashLaunch({ command: "ls -la" }, stubDeps());
    expect(result).toEqual({ continue: true });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("does NOT deny — always continues", () => {
    // The hook must never block a Bash call. Even for a weirdly-shaped
    // input, return `{continue: true}`.
    expect(handleBashLaunch(null, stubDeps())).toEqual({ continue: true });
    expect(handleBashLaunch({}, stubDeps())).toEqual({ continue: true });
    expect(handleBashLaunch({ command: 42 }, stubDeps())).toEqual({ continue: true });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("passes channelId from deps to upsert (not hardcoded)", () => {
    handleBashLaunch(
      { command: "codex exec > /tmp/run-plan-codex-slot-a.log 2>&1" },
      stubDeps("999999999999999999"),
    );
    expect(upsertMock).toHaveBeenCalledWith("slot-a", "999999999999999999", 1_700_000_000_000);
  });
});
