# Flush Stream Buffer Before Tool UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flush Claude's buffered streaming text into Discord before any tool approval / question UI is shown, so the explanation that precedes an `AskUserQuestion` / `Edit` / `Bash` prompt is actually visible.

**Architecture:** Extract the existing "split-and-edit" streaming logic in `session-manager.ts` into an exported `flushStreamBuffer` helper. Call it from both (a) the existing streaming throttle path (no behavior change), and (b) the top of `canUseTool` (new — flushes pending text before showing any tool UI). A new `bufferFinalized` flag tells the throttle path to start a fresh Discord message when streaming resumes after a tool flush, so the user's already-shown text isn't overwritten.

**Tech Stack:** TypeScript (ESM, strict, ES2022), discord.js v14, vitest for tests.

**Reference spec:** `docs/superpowers/specs/2026-05-28-flush-stream-buffer-before-tool-design.md`

---

## File Structure

- **Modify:** `src/claude/session-manager.ts` — add exported `flushStreamBuffer` helper, route throttle path through it, add `bufferFinalized` state, add canUseTool flush
- **Modify:** `src/claude/session-manager.test.ts` — add unit tests for `flushStreamBuffer`

No new files. The helper lives alongside its only caller because its inputs (channel, currentMessage, buffer) are session-scoped and don't generalize to other modules.

---

## Task 1: Write failing tests for `flushStreamBuffer`

**Files:**
- Modify: `src/claude/session-manager.test.ts`

- [ ] **Step 1: Add test imports and the test block**

At the top of `src/claude/session-manager.test.ts`, the imports already cover `vi`, `describe`, `it`, `expect`, `beforeEach` and the SDK mock. Add a new import for the helper (which doesn't exist yet — this is intentional, the test should fail to compile until Task 2):

```ts
import { sessionManager, flushStreamBuffer } from "./session-manager.js";
```

Then append this `describe` block at the bottom of the file, after the last existing `describe`:

```ts
// ─── flushStreamBuffer ───

describe("flushStreamBuffer", () => {
  // Build a minimal Message-like mock. The helper only touches .edit.
  function mockMessage() {
    return {
      edit: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  // Build a minimal TextChannel-like mock. The helper only touches .send.
  // Each .send returns a fresh mock Message so the helper can chain.
  function mockChannel() {
    const sent: any[] = [];
    const send = vi.fn().mockImplementation((_content: any) => {
      const msg = { edit: vi.fn().mockResolvedValue(undefined) };
      sent.push(msg);
      return Promise.resolve(msg);
    });
    return { channel: { send } as any, sent, send };
  }

  it("is a no-op for empty buffer", async () => {
    const { channel, send } = mockChannel();
    const current = mockMessage();
    const result = await flushStreamBuffer(channel, current, "");
    expect(current.edit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result.tail).toBe(current);
    expect(result.remainingBuffer).toBe("");
  });

  it("edits currentMessage when buffer fits in one chunk", async () => {
    const { channel, send } = mockChannel();
    const current = mockMessage();
    const result = await flushStreamBuffer(channel, current, "hello world");
    expect(current.edit).toHaveBeenCalledWith({
      content: "hello world",
      components: [],
    });
    expect(send).not.toHaveBeenCalled();
    expect(result.tail).toBe(current);
    // Single-chunk: buffer is preserved (existing streaming pattern —
    // the cumulative buffer keeps growing until an overflow drains it).
    expect(result.remainingBuffer).toBe("hello world");
  });

  it("edits + sends additional messages when buffer overflows", async () => {
    const { channel, send, sent } = mockChannel();
    const current = mockMessage();
    // 5000 chars forces splitMessage to produce multiple chunks
    // (MAX_DISCORD_LENGTH in output-formatter is 1900).
    const longBuffer = "a".repeat(5000);
    const result = await flushStreamBuffer(channel, current, longBuffer);
    expect(current.edit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalled();
    // tail is the LAST sent message, not the original currentMessage.
    expect(result.tail).toBe(sent[sent.length - 1]);
    // Multi-chunk overflow: buffer drains (preserves existing pattern).
    expect(result.remainingBuffer).toBe("");
  });

  it("falls back to channel.send when edit throws", async () => {
    const { channel, send, sent } = mockChannel();
    const current = mockMessage();
    current.edit = vi
      .fn()
      .mockRejectedValue(new Error("Unknown Message"));
    const result = await flushStreamBuffer(channel, current, "hello");
    expect(send).toHaveBeenCalled();
    // After fallback, tail points to the newly-sent message.
    expect(result.tail).toBe(sent[sent.length - 1]);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail to compile**

Run: `npm test -- session-manager`
Expected: vitest reports an error like `"flushStreamBuffer" is not exported by "src/claude/session-manager.ts"`. This confirms the test exists and is reaching for the helper we're about to implement.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/claude/session-manager.test.ts
git commit -m "test: failing tests for flushStreamBuffer helper"
```

---

## Task 2: Implement & export `flushStreamBuffer`

**Files:**
- Modify: `src/claude/session-manager.ts`

- [ ] **Step 1: Add the helper at the top of the file (before the `ActiveSession` interface)**

In `src/claude/session-manager.ts`, after the `PROGRESS_STALE_MS` constant block (around line 44, before `interface ActiveSession`), insert:

```ts
/**
 * Finalize `buffer` to Discord. Used by:
 *   (a) the streaming throttle path — when the 1500ms edit gate fires
 *   (b) the canUseTool flush — when a tool is about to show approval /
 *       question UI and we want preceding explanation text visible
 *
 * Returns the new "tail" Message (callers should treat this as the new
 * currentMessage for any subsequent streaming) and a `remainingBuffer`
 * value that callers in the throttle path should assign back to their
 * local buffer to preserve the existing cumulative-buffer behavior
 * (single-chunk: buffer preserved; multi-chunk overflow: buffer drained).
 *
 * Empty buffer is a zero-API-call no-op.
 *
 * Exported for unit testing — not part of the SessionManager class.
 */
export async function flushStreamBuffer(
  channel: TextChannel,
  currentMessage: Message,
  buffer: string,
): Promise<{ tail: Message; remainingBuffer: string }> {
  if (buffer.length === 0) {
    return { tail: currentMessage, remainingBuffer: "" };
  }

  const chunks = splitMessage(buffer);
  let tail = currentMessage;
  let remainingBuffer = buffer;

  try {
    await currentMessage.edit({
      content: chunks[0] || "...",
      components: [],
    });
    // Send overflow chunks as new messages. We track remainingBuffer the
    // way the original throttle path did: after each send, drop the
    // already-sent prefix so a future edit of `tail` (the new
    // currentMessage) won't re-render text the user has already seen.
    for (let i = 1; i < chunks.length; i++) {
      tail = await channel.send(chunks[i]);
      remainingBuffer = chunks.slice(i + 1).join("");
    }
  } catch (e) {
    console.warn(
      `[flush] Failed to edit ${currentMessage.id ?? "(unknown id)"}, sending new:`,
      e instanceof Error ? e.message : e,
    );
    tail = await channel.send({
      content: chunks[chunks.length - 1] || "...",
      components: [],
    });
  }

  return { tail, remainingBuffer };
}
```

Also ensure `Message` and `TextChannel` are imported (they already are at line 4 — verify):

```ts
import type { Message, TextChannel } from "discord.js";
```

- [ ] **Step 2: Run the helper tests to verify they pass**

Run: `npm test -- session-manager`
Expected: PASS for all four `flushStreamBuffer` test cases. Existing `SessionManager` tests should still pass too.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/claude/session-manager.ts
git commit -m "feat: add flushStreamBuffer helper for tool-time buffer flushing"
```

---

## Task 3: Route the streaming throttle path through `flushStreamBuffer`

This is a pure refactor — no behavior change. Replace the inline edit/send block in the streaming handler with a call to the new helper. Existing tests stay green.

**Files:**
- Modify: `src/claude/session-manager.ts` (lines ~426-452)

- [ ] **Step 1: Replace the inline throttle block**

In `src/claude/session-manager.ts`, find this block inside `sendMessage`'s for-await loop (currently around lines 426-452):

```ts
              // Throttled message edit
              const now = Date.now();
              if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
                lastEditTime = now;
                // Record that fresh text just streamed. This (a) suppresses
                // the next few progress ticks via the stale-threshold check
                // and (b) abandons any existing progress message so the next
                // stale window will create a fresh snapshot below the
                // latest streamed content rather than editing one that's
                // now above unrelated text.
                lastTextTime = now;
                progressMessage = null;
                const chunks = splitMessage(responseBuffer);
                try {
                  await currentMessage.edit({ content: chunks[0] || "...", components: [] });
                  // Send additional chunks as new messages
                  for (let i = 1; i < chunks.length; i++) {
                    currentMessage = await channel.send(chunks[i]);
                    responseBuffer = chunks.slice(i + 1).join("");
                  }
                } catch (e) {
                  console.warn(`[stream] Failed to edit message for ${channelId}, sending new:`, e instanceof Error ? e.message : e);
                  currentMessage = await channel.send(
                    chunks[chunks.length - 1] || "...",
                  );
                }
              }
```

Replace it with:

```ts
              // Throttled message edit
              const now = Date.now();
              if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
                lastEditTime = now;
                // Record that fresh text just streamed. This (a) suppresses
                // the next few progress ticks via the stale-threshold check
                // and (b) abandons any existing progress message so the next
                // stale window will create a fresh snapshot below the
                // latest streamed content rather than editing one that's
                // now above unrelated text.
                lastTextTime = now;
                progressMessage = null;
                const { tail, remainingBuffer } = await flushStreamBuffer(
                  channel,
                  currentMessage,
                  responseBuffer,
                );
                currentMessage = tail;
                responseBuffer = remainingBuffer;
              }
```

- [ ] **Step 2: Remove the now-unused `splitMessage` import IF no other call site remains**

Run: `grep -n "splitMessage" src/claude/session-manager.ts`
- If `flushStreamBuffer` is the only caller of `splitMessage` *inside this file*, leave the import alone — `flushStreamBuffer` still uses it.
- Do NOT remove the import. (The helper uses it.)

This step is a no-op for documentation — included so the implementer doesn't accidentally tear out the import.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass. No behavior change.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/claude/session-manager.ts
git commit -m "refactor: route streaming throttle path through flushStreamBuffer"
```

---

## Task 4: Add `bufferFinalized` state + `canUseTool` flush + fresh-message branch

This is the actual fix. After this task, Claude's pre-tool explanation text is visible in Discord.

**Files:**
- Modify: `src/claude/session-manager.ts`

- [ ] **Step 1: Add the `bufferFinalized` flag in `sendMessage`**

Find the streaming-state block (currently around lines 104-128) and add `bufferFinalized`:

```ts
    // Streaming state
    let responseBuffer = "";
    let lastEditTime = 0;
    const stopRow = createStopButton(channelId);
    let currentMessage = await channel.send({
      content: L("⏳ Thinking...", "⏳ 생각 중..."),
      components: [stopRow],
    });
    const EDIT_INTERVAL = 1500; // ms between edits (Discord rate limit friendly)
    // After a tool flush finalizes currentMessage, the next streamed
    // chunk must create a fresh Discord message — editing the finalized
    // one would overwrite text the user has already seen below it.
    let bufferFinalized = false;
```

(Add the comment + `let bufferFinalized = false;` line immediately after the `EDIT_INTERVAL` constant.)

- [ ] **Step 2: Handle `bufferFinalized` in the streaming throttle path**

Update the throttle block from Task 3 to create a new message when `bufferFinalized` is true. Replace:

```ts
              if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
                lastEditTime = now;
                lastTextTime = now;
                progressMessage = null;
                const { tail, remainingBuffer } = await flushStreamBuffer(
                  channel,
                  currentMessage,
                  responseBuffer,
                );
                currentMessage = tail;
                responseBuffer = remainingBuffer;
              }
```

With:

```ts
              if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
                lastEditTime = now;
                lastTextTime = now;
                progressMessage = null;

                if (bufferFinalized) {
                  // The previous tool flush froze currentMessage. Open a
                  // fresh message below it for this batch of streaming
                  // text, otherwise the helper would overwrite text the
                  // user has already read.
                  currentMessage = await channel.send("...");
                  bufferFinalized = false;
                }

                const { tail, remainingBuffer } = await flushStreamBuffer(
                  channel,
                  currentMessage,
                  responseBuffer,
                );
                currentMessage = tail;
                responseBuffer = remainingBuffer;
              }
```

- [ ] **Step 3: Add the flush block at the top of `canUseTool`**

Find the `canUseTool: async (toolName, input) => {` body (currently starts around line 240). The first lines are:

```ts
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          toolUseCount++;

          // Tool activity labels for Discord display
          const toolLabels: Record<string, string> = {
            ...
          };
          const filePath = ...
          lastActivity = ...

          // Surface progress on every tool use. ...
          await surfaceProgress();
```

**Immediately after** `await surfaceProgress();` and **before** the `if (toolName === "AskUserQuestion") {` block, insert:

```ts
          // Flush any pending streamed text into Discord before showing
          // a tool's approval / question UI. Without this, the
          // explanation Claude wrote in the same assistant turn as the
          // tool call is invisible — it's still buffered behind the
          // 1500ms throttle. AskUserQuestion is the most visible victim
          // (it then blocks for up to 5 minutes), but the same fix
          // applies to Edit / Write / Bash approval embeds.
          if (responseBuffer.length > 0) {
            const { tail } = await flushStreamBuffer(
              channel,
              currentMessage,
              responseBuffer,
            );
            currentMessage = tail;
            responseBuffer = "";
            bufferFinalized = true;
            lastEditTime = Date.now();
          }
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Verify `responseBuffer`, `currentMessage`, `bufferFinalized`, and `lastEditTime` are all visible from the `canUseTool` closure (they should be — they're declared in the same `sendMessage` body).

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all tests pass. The unit tests cover `flushStreamBuffer` in isolation; the integration is verified manually in Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/claude/session-manager.ts
git commit -m "fix: flush streamed text before tool approval / question UI

When Claude writes explanatory text immediately before calling a tool,
the text was buffered behind a 1500ms edit throttle and never appeared
in Discord — the user saw an AskUserQuestion (or Edit / Bash approval)
embed with no context above it. Now we flush the buffer at the top of
canUseTool and start a fresh message for any post-tool streamed text."
```

---

## Task 5: Build, full test suite, typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, no skipped or flaky.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: tsup completes without errors. Confirms the ESM output bundles correctly with the new export.

- [ ] **Step 4: If any step fails, fix inline and re-run; do NOT commit fixes as part of this task — they belong to the task that introduced the issue.**

---

## Task 6: Manual reproduction

**Files:** none (manual verification)

- [ ] **Step 1: Start the bot in dev mode**

Run: `npm run dev`
Wait for the "Bot ready" log line in the terminal.

- [ ] **Step 2: Trigger an AskUserQuestion scenario**

In a registered Discord channel, send:

> Look at `src/index.ts`, summarize what it does in 3 sentences, then ask me whether to add a comment explaining it.

Expected sequence in Discord:
1. `⏳ Thinking...` placeholder
2. Claude streams the 3-sentence summary (visible in the placeholder message, possibly across multiple edits)
3. **`AskUserQuestion` embed appears BELOW the summary** with the visible summary intact above it

**Before this fix:** the summary was invisible — only the embed appeared.
**After this fix:** the summary is visible above the embed.

- [ ] **Step 3: Trigger an Edit approval scenario**

In the same channel (or a fresh one):

> Add a one-line comment to the top of `src/index.ts` explaining what the file does.

Expected sequence:
1. Claude streams "I'll add a comment that says: …"
2. **Edit approval embed appears BELOW the intent text**

If the intent text isn't visible above the approval embed, the fix isn't working — re-check Task 4 Step 3 (the flush position inside `canUseTool`).

- [ ] **Step 4: Trigger a post-tool streaming continuation**

After the AskUserQuestion in Step 2, answer the question via the Discord button. Claude should resume and stream more text.

Expected:
- A *new* Discord message appears below the embed with Claude's continuation. The summary text from Step 2 stays frozen and visible.

If Claude's continuation overwrites the original summary, `bufferFinalized` isn't routing correctly — re-check Task 4 Step 2.

- [ ] **Step 5: Confirm no regression with pure streaming (no tool)**

Send:

> Write a haiku about Discord bots.

Expected:
- Streaming behaves exactly as before — one message edited progressively, no awkward "fresh message" splits, no buffer issues.

---

## Self-Review Checklist

After implementing all tasks, verify:

**Spec coverage:**
- [x] Spec §"Solution" → Tasks 2-4
- [x] Spec §"Design / flushStreamBuffer helper" → Task 2
- [x] Spec §"Design / sendMessage state additions" → Task 4 Step 1
- [x] Spec §"Design / Streaming throttle path changes" → Task 3 + Task 4 Step 2
- [x] Spec §"Design / canUseTool flush" → Task 4 Step 3
- [x] Spec §"Edge cases" → covered by unit tests in Task 1
- [x] Spec §"Testing / Manual reproduction" → Task 6
- [x] Spec §"Testing / Unit tests" → Task 1

**No placeholders:** every step has exact file paths, exact code, exact commands, exact expected output.

**Type consistency:** `flushStreamBuffer` is called the same way everywhere. The return shape `{ tail, remainingBuffer }` is consistent across helper definition (Task 2), test usage (Task 1), throttle path (Tasks 3 & 4), and canUseTool flush (Task 4).
