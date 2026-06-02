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

describe("/devsync status", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['status', '<repo>']) with the provided repo", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "Status: Watching for changes",
      stderr: "",
    });
    const interaction = makeInteraction("status", { repo: "alpha" });
    await execute(interaction);
    expect(runDevsync).toHaveBeenCalledWith(["status", "alpha"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Watching");
  });
});

describe("/devsync flush", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['flush', '<repo>']) and replies with success", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "✓ Flushed alpha--dl02.",
      stderr: "",
    });
    const interaction = makeInteraction("flush", { repo: "alpha" });
    await execute(interaction);
    expect(runDevsync).toHaveBeenCalledWith(["flush", "alpha"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Flushed");
  });
});

describe("/devsync stop", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['stop', '<repo>']) and replies", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "✓ Terminated 1 session(s) for repo 'alpha'.",
      stderr: "",
    });
    const interaction = makeInteraction("stop", { repo: "alpha" });
    await execute(interaction);
    expect(runDevsync).toHaveBeenCalledWith(["stop", "alpha"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Terminated");
  });
});

describe("/devsync stop_all", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("with zero sessions replies 'no sessions to terminate' without buttons", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });

    const interaction = makeInteraction("stop_all");
    await execute(interaction);

    // Should only check `ls`, never invoke stop --all
    expect(runDevsync).toHaveBeenCalledTimes(1);
    expect(runDevsync).toHaveBeenCalledWith(["ls"]);
    const arg = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content =
      typeof arg === "string" ? arg : (arg.content ?? JSON.stringify(arg));
    expect(content.toLowerCase()).toContain("no sessions");
  });

  it("with N>0 sessions replies with Confirm/Cancel buttons", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      // Mimic the CLI: header line + 2 entries
      stdout:
        "Name             Server\nalpha--dl01      dl01\nbeta--dl02       dl02",
      stderr: "",
    });

    const interaction = makeInteraction("stop_all");
    await execute(interaction);

    // Did not call stop --all yet; only ls
    expect(runDevsync).toHaveBeenCalledTimes(1);
    expect(runDevsync).toHaveBeenCalledWith(["ls"]);

    const arg = vi.mocked(interaction.editReply).mock.calls[0][0] as any;
    expect(arg.components).toBeDefined();
    expect(arg.components.length).toBeGreaterThan(0);
    const labels = arg.components[0].components.map((c: any) => c.data.label);
    expect(labels.some((l: string) => /confirm/i.test(l))).toBe(true);
    expect(labels.some((l: string) => /cancel/i.test(l))).toBe(true);
    const customIds = arg.components[0].components.map(
      (c: any) => c.data.custom_id,
    );
    expect(customIds).toContain("devsync:stop_all:confirm");
    expect(customIds).toContain("devsync:stop_all:cancel");
  });
});
