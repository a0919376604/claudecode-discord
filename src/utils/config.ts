import { z } from "zod";

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, "ALLOWED_USER_IDS is required")
    .transform((v) => v.split(",").map((id) => id.trim())),
  BASE_PROJECT_DIR: z.string().min(1, "BASE_PROJECT_DIR is required"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  SHOW_COST: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CLAUDE_MODEL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  // Maximum minutes a single Claude session may run before the bot
  // forcibly interrupts it. Default 60 — large enough for substantial
  // refactors, small enough to bound runaway token cost on a stuck
  // prompt. Set to 0 to disable (no ceiling). Coerced via Number() at the
  // call site to avoid forcing every test fixture to pass a string.
  MAX_SESSION_DURATION_MIN: z.coerce.number().int().nonnegative().default(60),
  // Refresh the Claude Code OAuth access token before it expires so
  // the user never has to re-run `claude login` while the bot is
  // running. macOS only for v1 — the refresher silently no-ops on
  // other platforms. Set to "false" to disable entirely.
  CLAUDE_AUTO_REFRESH: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Refresh the access token when it expires in less than this many
  // minutes. 30 is conservative enough to absorb retries on slow
  // networks while still avoiding gratuitous refreshes.
  CLAUDE_REFRESH_THRESHOLD_MIN: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Configuration error:\n${errors}`);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}
