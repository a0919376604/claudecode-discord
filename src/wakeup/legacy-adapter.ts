import fs from "node:fs";
import path from "node:path";
import { WakeupPayloadSchema, type WakeupPayload } from "./types.js";

interface AdapterOptions {
  /** Directory holding both done and meta files. Default: /tmp */
  metaDir?: string;
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Read /tmp/run-plan-done-<slot>.txt + its sibling meta file and produce a
 * WakeupPayload. Returns null if the file doesn't match the pattern, the meta
 * is missing, or channel_id wasn't recorded at launch (e.g., run launched
 * outside the bot).
 */
export function synthesizePayloadFromDoneFile(
  doneFilePath: string,
  opts: AdapterOptions = {},
): WakeupPayload | null {
  const base = path.basename(doneFilePath);
  const match = base.match(/^run-plan-done-(.+)\.txt$/);
  if (!match) return null;
  const slot = match[1];

  if (!fs.existsSync(doneFilePath)) return null;
  const done = parseKv(fs.readFileSync(doneFilePath, "utf-8"));

  const metaDir = opts.metaDir ?? path.dirname(doneFilePath);
  const metaPath = path.join(metaDir, `run-plan-meta-${slot}.txt`);
  if (!fs.existsSync(metaPath)) return null;
  const meta = parseKv(fs.readFileSync(metaPath, "utf-8"));

  const channelId = meta.channel_id;
  if (!channelId) return null;

  const candidate = {
    channel_id: channelId,
    prompt: `/run-plan status ${slot}`,
    source: "run-plan",
    metadata: {
      slot,
      status: done.status ?? "?",
      commits: done.commits ?? "?",
    },
    created_at: new Date().toISOString(),
  };

  const result = WakeupPayloadSchema.safeParse(candidate);
  return result.success ? result.data : null;
}
