# Finish Feature Button — Conversation History Management

Date: 2026-05-17
Status: Approved (pending implementation plan)
Branch: `feat/conversation-history-management`

## Summary

Every successful or failed result embed gains a `[✅ Finish Feature]`
button. Clicking it drops the channel's stored `session_id` so the next
message in the channel starts a brand-new Claude Agent SDK session with no
inherited conversation history. The button becomes disabled after one
click and the embed gains a visible "history cleared" footer note.

This addresses the long-running pain that motivated the brainstorm: when
a feature is done and the branch merges back to main, the Discord channel
still drags the entire conversation history into every subsequent prompt,
inflating input tokens and slowing each turn.

## Motivation

Today the bot resumes the previous Claude session for every message in a
channel (see `session-manager.ts` line 71/118). Over the lifetime of a
feature this accumulates dozens of turns, each loaded into context on
every subsequent request. The user reported that this — combined with
the UI-freeze bug already fixed in `feat/skip-permissions` — made
"sometimes it runs for an hour but no progress shows" feel even worse
because each turn was actually slower than it should have been.

The natural lifecycle marker for history is "feature done." Tying the
clear action to a button on each result embed gives the user a visible,
zero-friction control: ignore it during intermediate tasks (default
keep-history behavior is unchanged), click it once at feature wrap-up.

## Relationship to existing features

- **`/clear-sessions`**: Deletes JSONL session files from
  `~/.claude/projects/`. Nukes the source-of-truth files. The new
  button does NOT touch JSONL files — it only drops the `session_id`
  reference in `data.db`, so the user can still re-attach to the old
  session via `/sessions` if they clicked by mistake.
- **`/sessions`**: Picker that lists historical JSONL sessions and lets
  the user resume one. Acts as the recovery path for accidental clicks.
- **`/unregister`**: Untouched. Still removes the project mapping (and
  worktree folder, for worktree-registered channels). Orthogonal to
  history management.

## User-visible behavior

### On every result embed

Both success (green ✅) and error (red ❌) result embeds gain a single
action row with one button:

```
[✅ Finish Feature]   ← ButtonStyle.Success, emoji: ✅
```

Placement: same Discord message as the result embed (sent via
`channel.send({ embeds: [resultEmbed], components: [finishFeatureRow] })`).

### After click

1. Bot drops `session_id` from the `sessions` table for this channel
   (sets it to `NULL`, leaves the row so per-channel status tracking
   continues to work).
2. The button is replaced with a disabled `[✅ Feature finished]` button
   so the user gets visual feedback that it took effect.
3. The bot sends a short confirmation message to the channel:
   > `🆕 History cleared. The next message will start a fresh Claude session.`
   > `(Recover the old session with /sessions if this was a mistake.)`

### Idempotency

Clicking the same button twice (race, double-tap) is harmless: the
second click finds no `session_id` to drop and silently re-confirms the
disabled state. No error embed.

### What clear does NOT do

- Does NOT delete JSONL files in `~/.claude/projects/`.
- Does NOT unregister the channel.
- Does NOT remove the worktree folder.
- Does NOT cancel an in-flight session — the button only appears on a
  result embed, which by definition means the session already ended.
- Does NOT touch the message queue (`messageQueue` in session-manager).
  If a queued message exists, it will start the fresh session.

## Implementation surface

### Files touched

- `src/claude/output-formatter.ts` — new helper
  `createFinishFeatureButton(channelId: string)` returning
  `ActionRowBuilder<ButtonBuilder>`, parallel to `createStopButton` /
  `createCompletedButton`.
- `src/claude/session-manager.ts` — where the result embed is sent (one
  location, currently `await channel.send({ embeds: [resultEmbed] })`),
  attach the new row.
- `src/bot/handlers/interaction.ts` — new branch for `customId`
  prefix `finish-feature:` that:
  1. Calls a new `db/database.ts` helper `clearSessionId(channelId)`.
  2. Edits the original message to swap in the disabled "Feature
     finished" button.
  3. Sends the confirmation follow-up message.
- `src/db/database.ts` — new `clearSessionId(channelId: string)` helper
  that runs `UPDATE sessions SET session_id = NULL WHERE channel_id = ?`.

### Button customId scheme

`finish-feature:<channelId>`

The `channelId` segment is informational — the handler reads
`interaction.channelId` directly for authority. Keeping it in the
customId matches the convention used by `stop:<channelId>`.

### Status row impact

After clear, the next `/status` command for this channel should report
`⚪ idle` (or whatever the prior state was) — the row stays, just with
a NULL session_id. The next user message creates a fresh SDK session and
populates `session_id` again on the next `init` message.

## Failure modes

| Scenario | Behavior |
|---|---|
| Button click while another result embed is still pending in the channel | Allowed. The button operates on DB state only; in-flight sessions hold their `session_id` in memory via the `ActiveSession` entry. The in-flight session completes normally; the next NEW session starts fresh. |
| Click when `session_id` is already NULL (e.g., already clicked) | Idempotent. UPDATE affects 0 rows. Confirmation message still posts. |
| Click after `/unregister` removed the project | Confirmation falls back to `❌ This channel is no longer registered.` No DB write. |
| Discord edit fails (e.g., original message deleted) | Confirmation still posts; the disabled-button swap is logged via `console.warn` like other edit failures in this codebase. |

## Testing

Unit tests (new):

- `src/claude/output-formatter.test.ts`
  - `createFinishFeatureButton` returns a row with one button whose
    customId is `finish-feature:<channelId>`, label is localized, style
    Success.
- `src/db/database.test.ts`
  - `clearSessionId` sets `session_id` to NULL for the right channel.
  - `clearSessionId` on an unknown channel is a no-op (no throw).
  - Existing session row (status, auto-approve, etc.) is preserved.

Integration smoke (manual, documented in PR body):

- Send a message, get a result with the new button.
- Click `Finish Feature`. Verify the button disables and the
  confirmation lands in-channel.
- Send the next message. Verify `/status` shows fresh session
  (no resume) by checking that the SDK `init` system message carries
  a new `session_id`.

## Out of scope (future work)

- **Compact**: The original brainstorm considered three buttons
  (Compact / Clear / Keep). The user chose to ship just `Finish
  Feature` first because (a) "this is fastest" and (b) `/compact`
  routing through the Agent SDK still needs validation. A follow-up
  spec can add a second button `[🗜️ Compact]` next to the existing one
  once the SDK behavior is confirmed.
- **Threshold-based prompting**: Showing the button only when context
  exceeds N tokens or M turns. The current design shows it on every
  result embed because the cost (one extra Discord button) is trivial
  and the user can ignore it.
- **Auto-clear on `/unregister`**: Tempting to chain, but kept
  orthogonal so unregister remains a single-purpose admin command.

## Open questions

None — all major UX questions resolved during the brainstorm. The spec
is implementation-ready.
