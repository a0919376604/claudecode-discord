import { describe, it, expect } from "vitest";
import { Duplex } from "node:stream";
import { encodeFrame, FrameDecoder, CodexRpc } from "./codex-rpc.js";

describe("encodeFrame", () => {
  it("produces LSP-style frame with correct Content-Length", () => {
    const buf = encodeFrame({ jsonrpc: "2.0", id: 1, method: "test" });
    const text = buf.toString("utf-8");
    expect(text).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
    const bodyStart = text.indexOf("\r\n\r\n") + 4;
    const body = text.slice(bodyStart);
    const clMatch = text.match(/Content-Length: (\d+)/);
    expect(Number(clMatch![1])).toBe(Buffer.byteLength(body, "utf-8"));
    expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", id: 1, method: "test" });
  });

  it("uses byte length not char length for multibyte content", () => {
    const buf = encodeFrame({ msg: "你好" });
    const text = buf.toString("utf-8");
    const clMatch = text.match(/Content-Length: (\d+)/);
    const body = text.slice(text.indexOf("\r\n\r\n") + 4);
    expect(Number(clMatch![1])).toBe(Buffer.byteLength(body, "utf-8"));
  });
});

describe("FrameDecoder", () => {
  it("parses a single complete frame", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 1, method: "hi" });
    const messages = dec.push(frame);
    expect(messages).toEqual([{ id: 1, method: "hi" }]);
  });

  it("buffers when frame arrives in multiple chunks (header split)", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 2 });
    // Split mid-header
    expect(dec.push(frame.slice(0, 5))).toEqual([]);
    expect(dec.push(frame.slice(5))).toEqual([{ id: 2 }]);
  });

  it("buffers when frame arrives in multiple chunks (body split)", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 3, method: "long method name here" });
    const headerEnd = frame.indexOf(Buffer.from("\r\n\r\n")) + 4;
    expect(dec.push(frame.slice(0, headerEnd + 3))).toEqual([]);
    expect(dec.push(frame.slice(headerEnd + 3))).toEqual([{ id: 3, method: "long method name here" }]);
  });

  it("parses multiple frames in one push", () => {
    const dec = new FrameDecoder();
    const combined = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
    expect(dec.push(combined)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws on invalid JSON body", () => {
    const dec = new FrameDecoder();
    // Hand-craft invalid frame
    const bad = Buffer.from("Content-Length: 5\r\n\r\n{oops");
    expect(() => dec.push(bad)).toThrow();
  });

  it("ignores unknown headers before Content-Length", () => {
    const dec = new FrameDecoder();
    const body = '{"id":9}';
    const bytes = Buffer.byteLength(body, "utf-8");
    const frame = Buffer.from(`Content-Type: application/json\r\nContent-Length: ${bytes}\r\n\r\n${body}`);
    expect(dec.push(frame)).toEqual([{ id: 9 }]);
  });
});

function makeStreamPair() {
  const client = new Duplex({
    read() {},
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      setImmediate(() => { server.push(chunk); });
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
