import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => "/home/test" },
    homedir: () => "/home/test",
  };
});

import { getConfig } from "../utils/config.js";
import { resolveWakeupDir } from "./paths.js";

describe("resolveWakeupDir", () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset();
  });

  it("uses ~/.claudecode-discord/wakeups by default", () => {
    vi.mocked(getConfig).mockReturnValue({ WAKEUP_DIR_OVERRIDE: undefined } as ReturnType<typeof getConfig>);
    expect(resolveWakeupDir()).toBe("/home/test/.claudecode-discord/wakeups");
  });

  it("honors WAKEUP_DIR_OVERRIDE when set", () => {
    vi.mocked(getConfig).mockReturnValue({ WAKEUP_DIR_OVERRIDE: "/custom/dir" } as ReturnType<typeof getConfig>);
    expect(resolveWakeupDir()).toBe("/custom/dir");
  });
});
