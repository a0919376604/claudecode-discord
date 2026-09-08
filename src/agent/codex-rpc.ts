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
