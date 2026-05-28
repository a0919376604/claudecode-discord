# Flush stream buffer before tool UI

## Problem

When Claude writes explanatory text immediately before calling a tool that
triggers a Discord approval/question embed (most visibly `AskUserQuestion`,
but also `Edit` / `Write` / `Bash`), the text often never appears in
Discord. The user sees an embed asking "which option do you prefer?" with
no visible context for what's being chosen.

## Root cause

In `src/claude/session-manager.ts`, the assistant-text streaming path
throttles Discord message edits to once per 1500 ms (`EDIT_INTERVAL`):

```ts
if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
  // edit currentMessage with chunks[0] of responseBuffer
}
```

When `canUseTool` fires for a tool, the handler immediately sends a new
embed (approval prompt, question UI, etc.) but does **not** flush
`responseBuffer` to `currentMessage` first. If Claude streamed text within
the previous 1500 ms — which is the common case for "explanation → ask" —
that text is still sitting in the buffer when the embed appears below
`currentMessage`. `currentMessage` may still be showing the original
`⏳ Thinking...` placeholder.

The bug is most visible with `AskUserQuestion` because that handler then
blocks for up to 5 minutes waiting for the user's answer. For
`Edit` / `Write` / `Bash`, Claude eventually resumes after approval, the
streaming loop catches up, and the buffer flushes — but the user still
sees a moment where the approval prompt has no context.

## Solution

Before sending any tool-related Discord UI (approval embed,
AskUserQuestion embed, custom-input prompt), finalize whatever is in
`responseBuffer` to Discord. After the flush, the previously-streamed
message keeps its content frozen and the *next* assistant-text chunk
creates a new message below the tool embed rather than overwriting the
text the user just saw.

This applies uniformly to all tools that route through `canUseTool`'s
approval/question paths. Read-only tools (`Read`, `Glob`, `Grep`,
`WebSearch`, `WebFetch`, `TodoWrite`) auto-approve and never send UI, so
they don't need to flush — but the flush check sits high enough in
`canUseTool` that an empty buffer is a zero-cost no-op anyway.

### Visual flow

Before:
```
[⏳ Thinking...]      ← currentMessage; buffered text never flushed
[Question embed]      ← user sees this with no context
```

After:
```
[Claude's explanation]  ← buffer flushed before embed sent
[Question embed]
```

## Design

### `flushStreamBuffer` helper

New private function in `src/claude/session-manager.ts`:

```ts
/**
 * Finalize whatever is currently in `buffer` to Discord. Returns the
 * "tail" message — caller should treat this as the new currentMessage
 * for any later streaming chunk, and set a `bufferFinalized` flag so
 * the next streaming chunk creates a fresh message below it rather
 * than editing this one (which the user has already read).
 *
 * Empty buffer → returns currentMessage unchanged, makes no API call.
 * Buffer fits in one chunk → edits currentMessage, returns it.
 * Buffer overflows → edits currentMessage with chunk[0], sends
 *   remaining chunks as new messages, returns the last one sent.
 * Edit failure (e.g. message deleted) → falls back to channel.send.
 */
async function flushStreamBuffer(
  channel: TextChannel,
  currentMessage: Message,
  buffer: string,
): Promise<Message>;
```

This consolidates the split-and-edit logic that the streaming throttle
path currently inlines. Both call sites — the throttle path and the new
tool-flush path — use the same helper.

### `sendMessage` state additions

One new local in `sendMessage`:

```ts
let bufferFinalized = false;
// true after a flush froze currentMessage; next streamed chunk should
// create a NEW message instead of editing the frozen one
```

### Streaming throttle path changes

Inside the existing `message.type === "assistant"` handler, where the
throttle gate currently edits `currentMessage`:

```ts
if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
  lastEditTime = now;
  lastTextTime = now;
  progressMessage = null;

  if (bufferFinalized) {
    // Previous tool flush froze currentMessage. Start a fresh message
    // below it for this batch of streaming text.
    currentMessage = await channel.send("...");
    bufferFinalized = false;
  }

  currentMessage = await flushStreamBuffer(
    channel,
    currentMessage,
    responseBuffer,
  );
  // Note: responseBuffer keeps growing (existing pattern — each edit
  // re-renders the cumulative buffer). The buffer is only emptied
  // when a tool flush finalizes it.
}
```

### `canUseTool` flush

At the top of `canUseTool`, after `await surfaceProgress()` and before
any branch that sends Discord UI:

```ts
if (responseBuffer.length > 0) {
  currentMessage = await flushStreamBuffer(
    channel,
    currentMessage,
    responseBuffer,
  );
  responseBuffer = "";
  bufferFinalized = true;
  lastEditTime = Date.now();
}
```

This runs before:

1. The AskUserQuestion branch (sends question embed)
2. The auto-approve branch (no UI, but the flush still leaves the
   buffer in a clean state)
3. The approval embed branch (Edit / Write / Bash etc.)

Read-only tools fall through this check with an empty buffer in the
common case (text streams happen between tool calls, not right before a
read-only tool), so the early-exit guard makes them essentially free.

### Stop-button handling

The streamed message's Stop button is stripped during flush — the
finalized message no longer represents an in-progress task, and the
tool's own embed carries its own buttons. The current edit at the
throttle path already strips `components: []`; the helper preserves
that behavior.

## Edge cases

| Case | Behavior |
| --- | --- |
| Empty buffer | Helper early-returns; zero API calls |
| Buffer > 1900 chars | `splitMessage` chunks; edit `currentMessage` with chunk[0], `channel.send` for rest; return last sent |
| `currentMessage.edit` throws (message deleted) | Catch and fall back to `channel.send` |
| Sequential tools (AskUserQuestion → Edit → Bash) | First flush empties buffer; subsequent flushes are no-ops |
| Claude streams more text after a tool | `bufferFinalized=true` triggers new message creation; finalized text stays visible |
| User clicks Stop mid-flush | `stopSession()` doesn't touch buffer state; flush completes, then finally block tears down |
| Heartbeat tick during flush | `surfaceProgress` writes to `progressMessage`, not `currentMessage`; no conflict |
| Final result embed | Existing flush at result time stays as-is; tool flush sets `responseBuffer = ""` so the result-time flush is usually a no-op (correct: user already saw the text) |

## Out of scope

- Heartbeat / progress message logic (works correctly today)
- Display of tool image attachments (user clarified this isn't the issue)
- Final result embed flush (already correct)
- Refactoring the broader streaming model (e.g. switching off
  per-message buffering) — the focused fix here is enough to resolve
  the reported symptom

## Testing

### Manual reproduction

Repro prompt: "Look at `src/index.ts`, summarize what it does, then ask
me whether to refactor it."

Expected sequence:
1. Claude reads file (Read auto-approved, no UI)
2. Claude streams summary text into `currentMessage`
3. Claude calls `AskUserQuestion`
4. **Before fix:** only the question embed appears; the summary is
   invisible
5. **After fix:** the summary is fully visible above the question
   embed

Also verify `Edit` / `Bash` approval paths:
- "Edit `src/foo.ts` and add a comment explaining the function"
- Claude writes "I'll add a comment that says X" then calls Edit
- Approval embed should appear *below* Claude's intent description

### Unit tests

New `src/claude/session-manager.test.ts` (or add to existing test file
if present) using vitest:

```ts
describe("flushStreamBuffer", () => {
  it("returns currentMessage unchanged when buffer is empty", async () => {
    // assert no edit/send calls
  });

  it("edits currentMessage when buffer fits in one chunk", async () => {
    // assert edit called once with full buffer content
  });

  it("edits + sends additional messages when buffer overflows", async () => {
    // buffer = "a".repeat(5000)
    // assert edit called once, channel.send called for remaining chunks
    // assert return value is the last sent message
  });

  it("falls back to channel.send when edit throws", async () => {
    // mock currentMessage.edit to reject
    // assert channel.send called with full content
  });
});
```

### Regression checks

- Pure streaming (no tool calls): unchanged behavior, text appears with
  the usual 1500 ms cadence
- Read-only tools (Read, Glob, Grep) with empty buffer: no additional
  API calls vs. today
- AskUserQuestion timeout (5 min no answer): existing timeout path
  still fires; flush already happened so the user has full context
- Bot restart mid-session: unrelated to this fix

## Implementation order

1. Extract `flushStreamBuffer` helper, route the existing streaming
   throttle path through it (no behavior change)
2. Add `bufferFinalized` flag and the new-message branch in the
   throttle path
3. Add the flush block at the top of `canUseTool`
4. Add unit tests for `flushStreamBuffer`
5. Manual repro

Each step is independently committable.
