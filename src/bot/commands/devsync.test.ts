import { describe, it, expect, vi, beforeEach } from "vitest";
import { data, execute } from "./devsync.js";

vi.mock("../../utils/devsync-cli.js", () => ({
  runDevsync: vi.fn(),
}));

import { runDevsync } from "../../utils/devsync-cli.js";

function makeInteraction(subcommand: string, opts: Record<string, string> = {}) {
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string, required?: boolean) => {
        const v = opts[name];
        if (required && !v) throw new Error(`missing ${name}`);
        return v ?? null;
      }),
    },
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferred: true,
    replied: false,
  } as any;
}

describe("/devsync data", () => {
  it("declares subcommand 'doctor'", () => {
    const json = (data as any).toJSON();
    expect(json.name).toBe("devsync");
    const subs = json.options.map((o: any) => o.name);
    expect(subs).toContain("doctor");
  });
});

describe("/devsync doctor", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['doctor']) and wraps stdout in a code block", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "Mutagen daemon: running\nServers:\n dl01 reachable",
      stderr: "",
    });

    const interaction = makeInteraction("doctor");
    await execute(interaction);

    expect(runDevsync).toHaveBeenCalledWith(["doctor"]);
    const arg = vi.mocked(interaction.editReply).mock.calls[0][0];
    const text = typeof arg === "string" ? arg : (arg.content ?? "");
    expect(text).toContain("Mutagen daemon: running");
    expect(text).toContain("```");
  });

  it("on failure, formats stderr with exit code", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 3,
      stdout: "",
      stderr: "some error",
    });

    const interaction = makeInteraction("doctor");
    await execute(interaction);

    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("failed");
    expect(content).toContain("exit 3");
    expect(content).toContain("some error");
  });
});

describe("/devsync ls", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['ls']) and wraps output in a code block", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "Name   Server\nfoo    dl02",
      stderr: "",
    });

    const interaction = makeInteraction("ls");
    await execute(interaction);

    expect(runDevsync).toHaveBeenCalledWith(["ls"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("foo    dl02");
  });

  it("passes through the 'No active sessions' message from CLI", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });

    const interaction = makeInteraction("ls");
    await execute(interaction);

    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("No active sessions");
  });
});
