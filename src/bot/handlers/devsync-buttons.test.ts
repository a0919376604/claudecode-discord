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
