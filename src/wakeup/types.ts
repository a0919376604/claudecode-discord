import { z } from "zod";
import { createHash } from "node:crypto";

// Discord snowflakes are 17-20 digits (forward-compat for future Discord changes).
const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake");

export const WakeupPayloadSchema = z.object({
  channel_id: snowflake,
  prompt: z.string().min(1).max(4000),
  source: z.string().regex(/^[a-z0-9_-]+$/, "lowercase alphanumeric/_/- only").max(64),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().refine(
    (s) => !Number.isNaN(Date.parse(s)),
    "must be an ISO 8601 date string",
  ),
  ttl_seconds: z.number().int().positive().default(86400),
});

export type WakeupPayload = z.infer<typeof WakeupPayloadSchema>;

export interface WakeupQueueRow {
  id: number;
  channel_id: string;
  source: string;
  payload_json: string;
  queued_at: number; // unix ms
  dedupe_key: string | null;
}

/**
 * Stable dedupe key for a wake-up. Same (source, slot) collapses to one entry;
 * different slots stay distinct. For metadata without a `slot` field, we
 * canonicalize the object (sorted keys) and hash so equivalent metadata
 * produces the same key regardless of key insertion order.
 */
export function deriveDedupeKey(
  source: string,
  metadata: Record<string, unknown> | undefined,
  createdAt?: string,
): string {
  if (metadata && typeof metadata.slot === "string" && metadata.slot.length > 0) {
    return `${source}:${metadata.slot}`;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    const canonical = JSON.stringify(metadata, Object.keys(metadata).sort());
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    return `${source}:${hash}`;
  }
  return `${source}:${createdAt ?? ""}`;
}

export function isExpired(input: { created_at: string; ttl_seconds: number }): boolean {
  const created = Date.parse(input.created_at);
  if (Number.isNaN(created)) return true;
  return Date.now() > created + input.ttl_seconds * 1000;
}
