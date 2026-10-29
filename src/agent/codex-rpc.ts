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
  private failure: Error | null = null;

  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  private notifQueue: Array<{ method: string; params: unknown }> = [];
  private notifResolver: (() => void) | null = null;

  constructor(private stream: Duplex) {
    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    stream.on("error", (err: Error) => this.shutdown(err));
    stream.on("end", () => this.shutdown(new Error("Codex app-server disconnected")));
    stream.on("close", () => this.shutdown(new Error("Codex app-server stream closed")));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure ?? new Error("RPC closed"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
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
      if (this.closed) break;
      await new Promise<void>((resolve) => { this.notifResolver = resolve; });
    }
    if (this.failure) throw this.failure;
  }

  close(): void {
    if (this.closed) return;
    this.shutdown();
    this.stream.end();
  }

  private shutdown(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error ?? null;
    this.rejectAll(error ?? new Error("RPC closed"));
    if (this.notifResolver) {
      const r = this.notifResolver;
      this.notifResolver = null;
      r();
    }
  }

  private write(payload: object): void {
    if (this.closed) return;
    try {
      this.stream.write(encodeFrame(payload), (error) => {
        if (error) this.shutdown(error);
      });
    } catch (error) {
      this.shutdown(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onData(chunk: Buffer): void {
    let messages: object[];
    try {
      messages = this.decoder.push(chunk);
    } catch (e) {
      this.shutdown(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  protected dispatch(msg: object): void {
    const m = msg as {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };

    // Response to our request (has id that matches a pending entry, no method field for a pure response)
    if (m.method === undefined && typeof m.id === "number" && this.pending.has(m.id)) {
      const pending = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) pending.reject(new Error(m.error.message ?? "RPC error"));
      else pending.resolve(m.result);
      return;
    }

    // Server → client request (has id + method, not in our pending map)
    if ((typeof m.id === "number" || typeof m.id === "string") && typeof m.method === "string") {
      const handler = this.requestHandlers.get(m.method);
      if (!handler) {
        this.write({
          jsonrpc: "2.0", id: m.id,
          error: { code: -32601, message: `Method not found: ${m.method}` },
        });
        return;
      }
      Promise.resolve().then(() => handler(m.params))
        .then((result) => this.write({ jsonrpc: "2.0", id: m.id, result }))
        .catch((err: unknown) => this.write({
          jsonrpc: "2.0", id: m.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }));
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
