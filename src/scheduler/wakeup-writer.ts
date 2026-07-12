import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WakeupPayload } from "../wakeup/types.js";

/**
 * Atomically write a wakeup payload JSON to `dir`. Uses temp-file + rename
 * so `WakeupWatcher` never sees a half-written file.
 */
export async function writeWakeupFile(dir: string, payload: WakeupPayload): Promise<void> {
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const finalPath = path.join(dir, name);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  await fs.rename(tmpPath, finalPath);
}
