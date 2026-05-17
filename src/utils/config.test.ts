import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Set valid env vars
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.DISCORD_GUILD_ID = "test-guild";
    process.env.ALLOWED_USER_IDS = "user1,user2";
    process.env.BASE_PROJECT_DIR = "/projects";
    // Clear optional vars to use defaults
    delete process.env.RATE_LIMIT_PER_MINUTE;
    delete process.env.SHOW_COST;
    delete process.env.MAX_SESSION_DURATION_MIN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loadConfig returns valid config from environment", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.DISCORD_BOT_TOKEN).toBe("test-token");
    expect(config.DISCORD_GUILD_ID).toBe("test-guild");
    expect(config.ALLOWED_USER_IDS).toEqual(["user1", "user2"]);
    expect(config.BASE_PROJECT_DIR).toBe("/projects");
  });

  it("uses default values for optional fields", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.SHOW_COST).toBe(true);
    // 60 min is the default ceiling on a single session — long enough for
    // big refactors, short enough to bound runaway token cost from a
    // misbehaving prompt. Override via env when needed.
    expect(config.MAX_SESSION_DURATION_MIN).toBe(60);
  });

  it("coerces MAX_SESSION_DURATION_MIN to integer", async () => {
    process.env.MAX_SESSION_DURATION_MIN = "30";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.MAX_SESSION_DURATION_MIN).toBe(30);
  });

  it("accepts MAX_SESSION_DURATION_MIN=0 to disable the timeout", async () => {
    // Some users (especially trusted local dev) genuinely want no ceiling
    // and find a forced abort more annoying than a runaway session. 0 is
    // the canonical "off" value here.
    process.env.MAX_SESSION_DURATION_MIN = "0";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.MAX_SESSION_DURATION_MIN).toBe(0);
  });

  it("parses ALLOWED_USER_IDS with spaces", async () => {
    process.env.ALLOWED_USER_IDS = " user1 , user2 , user3 ";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.ALLOWED_USER_IDS).toEqual(["user1", "user2", "user3"]);
  });

  it("coerces RATE_LIMIT_PER_MINUTE to integer", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "20";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(20);
  });

  it("parses SHOW_COST as boolean", async () => {
    process.env.SHOW_COST = "false";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.SHOW_COST).toBe(false);
  });

  it("calls process.exit(1) when required env vars are missing", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("getConfig returns cached config on second call", async () => {
    const { loadConfig, getConfig } = await import("./config.js");
    const first = loadConfig();
    const second = getConfig();
    expect(first).toBe(second); // same reference
  });

  it("getConfig calls loadConfig if not yet loaded", async () => {
    const { getConfig } = await import("./config.js");
    const config = getConfig();
    expect(config.DISCORD_BOT_TOKEN).toBe("test-token");
  });
});
