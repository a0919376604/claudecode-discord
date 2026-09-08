export function encodeFrame(payload: object): Buffer {
  return Buffer.from(JSON.stringify(payload) + "\n", "utf-8");
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): object[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: object[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf(0x0a)) !== -1) {  // 0x0a = '\n'
      const line = this.buffer.slice(0, newlineIdx).toString("utf-8");
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.trim().length === 0) continue;  // ignore blank lines
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        throw new Error(`Invalid JSON in frame body: ${e instanceof Error ? e.message : e}`);
      }
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

  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  private notifQueue: Array<{ method: string; params: unknown }> = [];
  private notifResolver: (() => void) | null = null;

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

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  async *notifications(): AsyncIterableIterator<{ method: string; params: unknown }> {
    while (!this.closed || this.notifQueue.length > 0) {
      if (this.notifQueue.length > 0) {
        yield this.notifQueue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.notifResolver = resolve; });
    }
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("RPC closed"));
    if (this.notifResolver) {
      const r = this.notifResolver;
      this.notifResolver = null;
      r();
    }
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
    const m = msg as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };

    // Response to our request (has id that matches a pending entry, no method field for a pure response)
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const pending = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) pending.reject(new Error(m.error.message ?? "RPC error"));
      else pending.resolve(m.result);
      return;
    }

    // Server → client request (has id + method, not in our pending map)
    if (typeof m.id === "number" && typeof m.method === "string") {
      const handler = this.requestHandlers.get(m.method);
      if (!handler) {
        this.stream.write(encodeFrame({
          jsonrpc: "2.0", id: m.id,
          error: { code: -32601, message: `Method not found: ${m.method}` },
        }));
        return;
      }
      handler(m.params)
        .then((result) => this.stream.write(encodeFrame({ jsonrpc: "2.0", id: m.id, result })))
        .catch((err: unknown) => this.stream.write(encodeFrame({
          jsonrpc: "2.0", id: m.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        })));
      return;
    }

    // Notification (no id, has method)
    if (typeof m.method === "string") {
      const handler = this.notificationHandlers.get(m.method);
      if (handler) handler(m.params);
      this.notifQueue.push({ method: m.method, params: m.params });
      if (this.notifResolver) {
        const r = this.notifResolver;
        this.notifResolver = null;
        r();
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
