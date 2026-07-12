import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeWakeupFile } from "./wakeup-writer.js";
import { WakeupPayloadSchema } from "../wakeup/types.js";

describe("writeWakeupFile", () => {
  it("writes a valid WakeupPayload JSON file with a unique name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wakeup-writer-test-"));
    try {
      const payload = {
        channel_id: "123456789012345678",
        prompt: "check R-018",
        source: "schedule_wakeup",
        metadata: { schedule_id: "sch_abc" },
        created_at: new Date(1_700_000_000_000).toISOString(),
        ttl_seconds: 60,
      };
      await writeWakeupFile(dir, payload);

      const entries = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
      expect(entries).toHaveLength(1);
      const parsed = JSON.parse(await fs.readFile(path.join(dir, entries[0]), "utf-8"));
      const result = WakeupPayloadSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
