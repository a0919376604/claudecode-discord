import os from "node:os";
import path from "node:path";
import { getConfig } from "../utils/config.js";

/**
 * Absolute path to the wake-up drop directory. Honors WAKEUP_DIR_OVERRIDE
 * for tests, otherwise resolves to ~/.claudecode-discord/wakeups.
 */
export function resolveWakeupDir(): string {
  const override = getConfig().WAKEUP_DIR_OVERRIDE;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".claudecode-discord", "wakeups");
}
