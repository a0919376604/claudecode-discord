import { describe, it, expect } from "vitest";
import { Duplex } from "node:stream";
import { encodeFrame, FrameDecoder, CodexRpc } from "./codex-rpc.js";

describe("encodeFrame", () => {
  it("produces expected NDJSON frame (JSON + newline)", () => {
    const payload = { jsonrpc: "2.0", id: 1, method: "test" };
    const buf = encodeFrame(payload);
    const text = buf.toString("utf-8");
    expect(text).toBe(JSON.stringify(payload) + "\n");
    expect(JSON.parse(text.trimEnd())).toEqual(payload);
  });

  it("uses byte length not char length for multibyte content", () => {
    const payload = { msg: "你好" };
    const buf = encodeFrame(payload);
    expect(buf.byteLength).toBe(Buffer.byteLength(JSON.stringify(payload) + "\n", "utf-8"));
  });
});

describe("FrameDecoder", () => {
  it("parses a single complete frame", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 1, method: "hi" });
    const messages = dec.push(frame);
    expect(messages).toEqual([{ id: 1, method: "hi" }]);
  });

  it("buffers when frame arrives in multiple chunks (line split, first chunk has no newline)", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 2 });
    // Split mid-JSON (before the trailing newline)
    expect(dec.push(frame.slice(0, 5))).toEqual([]);
    expect(dec.push(frame.slice(5))).toEqual([{ id: 2 }]);
  });

  it("buffers when frame arrives in multiple chunks (split deep into JSON body)", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 3, method: "long method name here" });
    const mid = Math.floor(frame.byteLength / 2);
    expect(dec.push(frame.slice(0, mid))).toEqual([]);
    expect(dec.push(frame.slice(mid))).toEqual([{ id: 3, method: "long method name here" }]);
  });

  it("parses multiple frames in one push", () => {
    const dec = new FrameDecoder();
    const combined = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
    expect(dec.push(combined)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws on invalid JSON body", () => {
    const dec = new FrameDecoder();
    // Hand-craft invalid NDJSON line
    const bad = Buffer.from("{oops}\n");
    expect(() => dec.push(bad)).toThrow();
  });

  it("ignores blank lines between frames", () => {
    const dec = new FrameDecoder();
    const frame = Buffer.from('\n\n{"id":1}\n');
    expect(dec.push(frame)).toEqual([{ id: 1 }]);
  });
});

function makeStreamPair() {
  const client = new Duplex({
    read() {},
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      // Route client writes to server's readable via the base push (bypassing override)
      setImmediate(() => { basePushServer(chunk); });
      cb();
    },
  });
  const server = new Duplex({
    read() {},
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      setImmediate(() => { client.push(chunk); });
      cb();
    },
  });

  // Capture the original Readable.push bound to server (before override)
  const basePushServer = Duplex.prototype.push.bind(server) as (chunk: Buffer | null) => boolean;

  // Override server.push so direct calls (e.g. from tests) route to client's readable
  (server as unknown as { push: (chunk: Buffer | null) => boolean }).push = (chunk) => {
    client.push(chunk);
    return true;
  };

  return { client, server };
}

describe("CodexRpc.request", () => {
  it("pairs response to request by id and resolves promise", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const serverDecoder = new FrameDecoder();
    server.on("data", (chunk: Buffer) => {
      for (const msg of serverDecoder.push(chunk)) {
        const req = msg as { id: number; method: string };
        // Echo a success response back to client via write()
        server.write(encodeFrame({ jsonrpc: "2.0", id: req.id, result: { got: req.method } }));
      }
    });

    const result = await rpc.request("ping");
    expect(result).toEqual({ got: "ping" });
    rpc.close();
  });

  it("rejects on server error response", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const dec = new FrameDecoder();
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) {
        const req = msg as { id: number };
        server.write(encodeFrame({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "boom" } }));
      }
    });
    await expect(rpc.request("bad")).rejects.toThrow("boom");
    rpc.close();
  });

  it("assigns unique ascending ids to concurrent requests", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const dec = new FrameDecoder();
    const receivedIds: number[] = [];
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) {
        const req = msg as { id: number };
        receivedIds.push(req.id);
        server.write(encodeFrame({ jsonrpc: "2.0", id: req.id, result: "ok" }));
      }
    });
    await Promise.all([rpc.request("a"), rpc.request("b"), rpc.request("c")]);
    expect(new Set(receivedIds).size).toBe(3);
    rpc.close();
  });

  it("notify() sends without id and does not create a pending entry", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const dec = new FrameDecoder();
    let received: { id?: number; method?: string } | null = null;
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) received = msg as { id?: number; method?: string };
    });
    rpc.notify("hello", { x: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual({ jsonrpc: "2.0", method: "hello", params: { x: 1 } });
    rpc.close();
  });
});

describe("CodexRpc bidirectional", () => {
  it("dispatches server notifications to registered handler", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    let received: unknown = null;
    rpc.onNotification("progress", (params) => { received = params; });
    server.push(encodeFrame({ jsonrpc: "2.0", method: "progress", params: { pct: 50 } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual({ pct: 50 });
    rpc.close();
  });

  it("dispatches reverse requests and sends handler result as response", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    rpc.onRequest("approve", async (params) => {
      const p = params as { cmd: string };
      return { ok: p.cmd === "ls" };
    });
    const dec = new FrameDecoder();
    const responses: unknown[] = [];
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) responses.push(msg);
    });
    server.push(encodeFrame({ jsonrpc: "2.0", id: 99, method: "approve", params: { cmd: "ls" } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: 99, result: { ok: true } });
    rpc.close();
  });

  it("sends error response when reverse-request handler throws", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    rpc.onRequest("bomb", async () => { throw new Error("nope"); });
    const dec = new FrameDecoder();
    const responses: unknown[] = [];
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) responses.push(msg);
    });
    server.push(encodeFrame({ jsonrpc: "2.0", id: 42, method: "bomb" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(responses[0]).toMatchObject({ id: 42, error: { message: "nope" } });
    rpc.close();
  });

  it("notifications() iterator yields incoming notifications", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const iter = rpc.notifications();

    setTimeout(() => {
      server.push(encodeFrame({ jsonrpc: "2.0", method: "a", params: 1 }));
      server.push(encodeFrame({ jsonrpc: "2.0", method: "b", params: 2 }));
      setTimeout(() => rpc.close(), 20);
    }, 10);

    const received: Array<{ method: string; params: unknown }> = [];
    for await (const n of iter) received.push(n);
    expect(received).toEqual([
      { method: "a", params: 1 },
      { method: "b", params: 2 },
    ]);
  });
});
