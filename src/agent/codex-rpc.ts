export function encodeFrame(payload: object): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf-8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf-8");
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): object[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: object[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd === -1) break;

      const headerText = this.buffer.slice(0, headerEnd).toString("utf-8");
      const clMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!clMatch) {
        throw new Error(`Missing Content-Length header in frame: ${headerText}`);
      }
      const contentLength = Number(clMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.byteLength < bodyEnd) break;

      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf-8");
      let parsed: object;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        throw new Error(`Invalid JSON in frame body: ${e instanceof Error ? e.message : e}`);
      }
      messages.push(parsed);
      this.buffer = this.buffer.slice(bodyEnd);
    }

    return messages;
  }
}

import type { Duplex } from "node:stream";

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class CodexRpc {
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private decoder = new FrameDecoder();
  private closed = false;

  constructor(private stream: Duplex) {
    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    stream.on("error", (err: Error) => this.rejectAll(err));
    stream.on("close", () => this.rejectAll(new Error("Stream closed")));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("RPC closed"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.stream.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.stream.write(encodeFrame({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("RPC closed"));
    this.stream.end();
  }

  private onData(chunk: Buffer): void {
    let messages: object[];
    try {
      messages = this.decoder.push(chunk);
    } catch (e) {
      this.rejectAll(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  protected dispatch(msg: object): void {
    const m = msg as { id?: number; result?: unknown; error?: { message?: string } };
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const pending = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) pending.reject(new Error(m.error.message ?? "RPC error"));
      else pending.resolve(m.result);
    }
    // Notifications and reverse requests handled in subclass (Task 10)
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
