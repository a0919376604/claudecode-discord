#!/usr/bin/env node
// Manual smoke test: connects to `codex app-server`, sends a "hello" turn,
// prints all item/agentMessage/delta events, exits when turn/completed.
//
// Run: node scripts/codex-rpc-demo.mjs
// Prereq: codex CLI installed and logged in.
// Build first: npm run build

import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { CodexRpc } from "../dist/agent/codex-rpc.js";

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});

proc.on("error", (err) => {
  console.error("[demo] failed to spawn codex:", err.message);
  process.exit(1);
});

// Use Duplex.from to compose proc.stdout (read) + proc.stdin (write).
// This is the same pattern Task 15 (CodexBackend) will rely on.
const transport = Duplex.from({
  readable: proc.stdout,
  writable: proc.stdin,
});

const rpc = new CodexRpc(transport);

async function main() {
  console.log("[demo] initialize...");
  const init = await rpc.request("initialize", {
    clientInfo: { name: "claudecode-discord-demo", version: "0.0.1" },
    capabilities: {},
  });
  console.log("[demo] init result:", JSON.stringify(init));

  rpc.notify("initialized", {});

  console.log("[demo] thread/start...");
  // thread/start response: { thread: { id, ... }, ... }
  const threadResp = await rpc.request("thread/start", {
    cwd: process.cwd(),
    sandbox: "read-only",
  });
  const threadId = threadResp.thread.id;
  console.log("[demo] threadId:", threadId);

  console.log("[demo] turn/start...");
  // turn/start response: { turn: { id, ... } }
  // Do NOT await here — notifications arrive concurrently with the response.
  rpc
    .request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Say hello in one word." }],
    })
    .then((turnResp) => console.log("[demo] turnId:", turnResp.turn.id))
    .catch((err) => console.error("[demo] turn/start error:", err.message));

  for await (const notif of rpc.notifications()) {
    if (notif.method === "item/agentMessage/delta") {
      process.stdout.write(String(notif.params?.delta ?? ""));
    } else if (notif.method === "turn/completed") {
      console.log("\n[demo] turn complete");
      rpc.close();
      proc.kill();
      process.exit(0);
    } else if (notif.method === "thread/closed") {
      console.log("\n[demo] thread closed unexpectedly");
      rpc.close();
      proc.kill();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("[demo] error:", err);
  rpc.close();
  proc.kill();
  process.exit(1);
});
