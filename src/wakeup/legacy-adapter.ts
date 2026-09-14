import fs from "node:fs";
import path from "node:path";
import { WakeupPayloadSchema, type WakeupPayload } from "./types.js";
import { getProjectByPath } from "../db/database.js";

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
 * Resolve the Discord channel for a run-plan slot, in this order:
 *   1. `channel_id=` in the meta file (skill's Step 3 default).
 *   2. `/tmp/run-plan-channel-<slot>.txt` (stable landmark that skill
 *      writes ONCE at launch — survives Claude's manual retry that
 *      rewrites the meta file with `>` and loses channel_id).
 *   3. DB lookup by cwd: if the meta's cwd matches a bot-registered
 *      project, use that channel. Last-resort safety net for runs
 *      launched via a shell that didn't inherit WAKEUP_CHANNEL_ID.
 *
 * Returns null if none of the above yields a usable Discord snowflake.
 * Exported for unit-test coverage of each fallback layer.
 */
export function resolveChannelForSlot(
  slot: string,
  meta: Record<string, string>,
  opts: { channelFileDir?: string } = {},
): string | null {
  if (meta.channel_id && meta.channel_id.length > 0) return meta.channel_id;

  const channelDir = opts.channelFileDir ?? "/tmp";
  const channelFile = path.join(channelDir, `run-plan-channel-${slot}.txt`);
  if (fs.existsSync(channelFile)) {
    const contents = fs.readFileSync(channelFile, "utf-8").trim();
    if (contents.length > 0) return contents;
  }

  if (meta.cwd && meta.cwd.length > 0) {
    // Defensive: DB might not be initialized in test contexts, or a schema
    // migration could throw. The fallback must never propagate an error
    // to the wakeup dispatch path.
    try {
      const project = getProjectByPath(meta.cwd);
      if (project?.channel_id) return project.channel_id;
    } catch {
      // ignore — treat as "no project found"
    }
  }

  return null;
}

/**
 * Read /tmp/run-plan-done-<slot>.txt + its sibling meta file and produce a
 * WakeupPayload. Returns null if the file doesn't match the pattern, the meta
 * is missing, or all channel-resolution fallbacks failed (e.g., run launched
 * outside the bot with no way to route back).
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

  const channelId = resolveChannelForSlot(slot, meta, { channelFileDir: metaDir });
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
