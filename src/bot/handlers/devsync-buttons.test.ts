import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDevsyncButton } from "./devsync-buttons.js";

vi.mock("../../utils/devsync-cli.js", () => ({
  runDevsync: vi.fn(),
}));

import { runDevsync } from "../../utils/devsync-cli.js";

function makeButton(customId: string) {
  return {
    customId,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
  } as any;
}

describe("handleDevsyncButton", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("stop_all:confirm calls runDevsync(['stop', '--all'])", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "✓ Terminated 3 session(s).",
      stderr: "",
    });
    const i = makeButton("devsync:stop_all:confirm");
    await handleDevsyncButton(i);
    expect(runDevsync).toHaveBeenCalledWith(["stop", "--all"]);
    expect(i.editReply).toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.components).toEqual([]);
  });

  it("stop_all:cancel does not call runDevsync", async () => {
    const i = makeButton("devsync:stop_all:cancel");
    await handleDevsyncButton(i);
    expect(runDevsync).not.toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/cancel/i);
    expect(arg.components).toEqual([]);
  });

  it("stop_all:confirm propagates failure with exit code", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "daemon down",
    });
    const i = makeButton("devsync:stop_all:confirm");
    await handleDevsyncButton(i);
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/exit 1/);
    expect(arg.content).toMatch(/daemon down/);
  });
});

describe("handleDevsyncButton — start", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("start:reuse:<name> replies 'Reusing' and does NOT call runDevsync", async () => {
    const i = makeButton("devsync:start:reuse:foo--dl02");
    await handleDevsyncButton(i);
    expect(runDevsync).not.toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/reusing/i);
    expect(arg.components).toEqual([]);
  });

  it("start:cancel replies 'Cancelled' and does NOT call runDevsync", async () => {
    const i = makeButton("devsync:start:cancel");
    await handleDevsyncButton(i);
    expect(runDevsync).not.toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/cancel/i);
  });

  it("start:restart:<name> stops then starts in order", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true, code: 0, stdout: "stopped", stderr: "",
    });
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true, code: 0, stdout: "→ Sync session created: foo--dl02", stderr: "",
    });
    const i = makeButton("devsync:start:restart:foo--dl02");
    await handleDevsyncButton(i);
    expect(runDevsync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runDevsync).mock.calls[0][0]).toEqual(["stop", "foo"]);
    expect(vi.mocked(runDevsync).mock.calls[1][0]).toEqual(["start", "foo", "dl02", "--no-ssh"]);
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/restarted/i);
  });

  it("start:restart:<name> propagates failure if stop fails (does not call start)", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: false, code: 1, stdout: "", stderr: "daemon down",
    });
    const i = makeButton("devsync:start:restart:foo--dl02");
    await handleDevsyncButton(i);
    expect(runDevsync).toHaveBeenCalledTimes(1); // only stop, no start
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/could not stop/i);
  });
});
