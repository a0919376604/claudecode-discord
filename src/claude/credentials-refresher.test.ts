import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable mocked config so individual tests can override
const mockConfig = {
  CLAUDE_AUTO_REFRESH: true,
  CLAUDE_REFRESH_THRESHOLD_MIN: 30,
};

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

import { ensureFreshCredentials } from "./credentials-refresher.js";

describe("ensureFreshCredentials", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockConfig.CLAUDE_AUTO_REFRESH = true;
    mockConfig.CLAUDE_REFRESH_THRESHOLD_MIN = 30;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("no-ops on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    // mockResolvedValue is a safety net — if the implementation regresses
    // and DOES call fetch, the spy intercepts so we don't make a real HTTP
    // request from the test runner. The assertion still fails.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when CLAUDE_AUTO_REFRESH is false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_AUTO_REFRESH = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
