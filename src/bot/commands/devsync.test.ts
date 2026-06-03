import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("/devsync start", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("with no existing session, spawns devsync start with --no-ssh", async () => {
    // First call: ls (no match) → empty list output
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });
    // Second call: actual start
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout: "→ Sync session created: foo--dl02",
      stderr: "",
    });

    const interaction = makeInteraction("start", { repo: "foo", server: "dl02" });
    await execute(interaction);

    expect(runDevsync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runDevsync).mock.calls[0][0]).toEqual(["ls"]);
    const expectedPath = path.join(os.homedir(), "Desktop", "code", "foo");
    expect(vi.mocked(runDevsync).mock.calls[1][0]).toEqual([
      "start",
      "dl02",
      expectedPath,
      "--no-ssh",
    ]);

    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Sync session created");
  });

  it("with existing session, replies with 3 buttons (Reuse/Restart/Cancel)", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout:
        "Name             Server\nfoo--dl02        dl02",
      stderr: "",
    });

    const interaction = makeInteraction("start", { repo: "foo", server: "dl02" });
    await execute(interaction);

    // Did not spawn start; only ls
    expect(runDevsync).toHaveBeenCalledTimes(1);

    const arg = vi.mocked(interaction.editReply).mock.calls[0][0] as any;
    expect(arg.components).toBeDefined();
    const customIds = arg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toContain("devsync:start:reuse:foo--dl02");
    expect(customIds).toContain("devsync:start:restart:foo--dl02");
    expect(customIds).toContain("devsync:start:cancel");
  });

  it("falls back to buttons when start fails with 'already exists' race", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true, code: 0, stdout: "No active sessions.", stderr: "",
    });
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: false, code: 1, stdout: "",
      stderr: "Mutagen session 'foo--dl02' already exists.",
    });

    const interaction = makeInteraction("start", { repo: "foo", server: "dl02" });
    await execute(interaction);

    const arg = vi.mocked(interaction.editReply).mock.calls[0][0] as any;
    // Should NOT just print the failure — should show 3 buttons.
    expect(arg.components).toBeDefined();
    const customIds = arg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toContain("devsync:start:reuse:foo--dl02");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autocomplete } from "./devsync.js";

function makeAutocomplete(subcommand: string, optionName: string, focused: string) {
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getFocused: vi.fn(() => ({ name: optionName, value: focused })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("/devsync autocomplete — server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns keys of [servers.*] from config.toml", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      if (String(p).endsWith("/.config/devsync/config.toml")) {
        return [
          "[defaults]",
          'code_root = "/x"',
          'remote_base = "/y"',
          "",
          "[servers.dl01]",
          'host = "dl01"',
          "",
          "[servers.dl02]",
          'host = "dl02"',
          "",
          "[servers.dl03]",
          'host = "dl03"',
        ].join("\n");
      }
      throw new Error("unexpected path: " + p);
    });

    const i = makeAutocomplete("start", "server", "");
    await autocomplete(i);
    expect(i.respond).toHaveBeenCalled();
    const choices = vi.mocked(i.respond).mock.calls[0][0];
    const names = choices.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["dl01", "dl02", "dl03"]));
  });

  it("filters by focused prefix", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      ["[servers.dl01]", "host = \"dl01\"", "", "[servers.dl02]", "host = \"dl02\"", "", "[servers.gpu1]", "host = \"gpu1\""].join("\n"),
    );
    const i = makeAutocomplete("start", "server", "dl");
    await autocomplete(i);
    const names = vi.mocked(i.respond).mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["dl01", "dl02"]));
    expect(names).not.toContain("gpu1");
  });

  it("returns empty array if config.toml is missing", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const e: NodeJS.ErrnoException = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    });
    const i = makeAutocomplete("start", "server", "");
    await autocomplete(i);
    expect(i.respond).toHaveBeenCalledWith([]);
  });
});

describe("/devsync autocomplete — repo", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("returns distinct repo names extracted from `devsync ls` output", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: [
        "Name             Server",
        "alpha--dl01      dl01",
        "alpha--dl02      dl02",
        "beta--dl01       dl01",
      ].join("\n"),
      stderr: "",
    });

    const i = makeAutocomplete("stop", "repo", "");
    await autocomplete(i);
    const names = vi.mocked(i.respond).mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta"]));
    // De-duped: 'alpha' should appear once
    expect(names.filter((n: string) => n === "alpha").length).toBe(1);
  });

  it("filters by focused prefix", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: ["alpha--dl01", "beta--dl02", "gamma--dl03"].join("\n"),
      stderr: "",
    });
    const i = makeAutocomplete("stop", "repo", "b");
    await autocomplete(i);
    const names = vi.mocked(i.respond).mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(["beta"]);
  });

  it("returns empty when ls fails or no sessions", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });
    const i = makeAutocomplete("stop", "repo", "");
    await autocomplete(i);
    expect(i.respond).toHaveBeenCalledWith([]);
  });
});

describe("/devsync error enrichment", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("appends install hint when exit code is 127 (ENOENT)", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 127,
      stdout: "",
      stderr: "devsync CLI not found. Install: uv tool install ~/Desktop/code/devsync",
    });
    const interaction = makeInteraction("doctor");
    await execute(interaction);
    const content = vi.mocked(interaction.editReply).mock.calls[0][0].content;
    expect(content).toMatch(/uv tool install/);
  });

  it("appends VPN hint when stderr mentions 'Cannot reach server'", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 3,
      stdout: "",
      stderr: "Cannot reach server 'dl02' (192.168.90.32): timeout",
    });
    const interaction = makeInteraction("doctor");
    await execute(interaction);
    const content = vi.mocked(interaction.editReply).mock.calls[0][0].content;
    expect(content).toMatch(/VPN/i);
  });

  it("truncates output longer than 1900 chars", async () => {
    const long = "x".repeat(3000);
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: long,
      stderr: "",
    });
    const interaction = makeInteraction("doctor");
    await execute(interaction);
    const content = vi.mocked(interaction.editReply).mock.calls[0][0].content;
    expect(content).toMatch(/\(truncated\)/);
    expect(content.length).toBeLessThan(2000);
  });
});
