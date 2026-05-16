# Skip Permissions Toggle Design

Date: 2026-05-16
Status: Approved (pending implementation plan)

## Summary

Add a global toggle that, when enabled, makes the bot invoke Claude with
`permissionMode: 'bypassPermissions'` (the Agent SDK equivalent of the
Claude CLI's `--dangerously-skip-permissions` flag). The toggle lives in
each platform's system tray app as a checkable menu item, persists to a
sidecar file, and is read fresh by the bot at the start of every Claude
query so toggling takes effect on the next session without restarting the
bot.

## Motivation

Today every write tool (Edit, Write, Bash) routes through `canUseTool` and
the bot shows a Discord approval button (unless the channel has
`/auto-approve` on). For users who want full autonomy on a trusted machine,
this is friction. The Agent SDK supports `permissionMode:
'bypassPermissions'` which skips all permission checks entirely, including
the `canUseTool` callback. Exposing this as a global toggle gives users an
explicit "I know what I'm doing" mode without a per-channel command.

## Relationship to existing features

- **`/auto-approve`** is a *bot-level* convenience: the bot's `canUseTool`
  callback automatically returns `allow`, but the callback still fires and
  the cost embed still renders. Per-channel.
- **Skip Permissions (this feature)** is an *SDK-level* bypass: the SDK
  skips permission checks before the callback ever runs. Global.

Both can be enabled; if Skip Permissions is on, `/auto-approve` is moot
because `canUseTool` never fires.

## Behaviour visible to the user

### When enabled

- All write tools (Edit, Write, Bash, etc.) run without Discord approval
  buttons.
- `AskUserQuestion` popups, which the bot detects inside `canUseTool`, no
  longer appear — Claude is expected to make its own choices.
- Per-tool cost / result embeds (which today are emitted from
  `canUseTool`) no longer appear. Final cost/duration embeds still appear
  at session end.

### When disabled (default)

Behaviour is exactly as it is today.

## Storage

A new sidecar file at `<botDir>/.skip-permissions`, consistent with the
existing `.tray-lang` pattern:

- File missing or content (after trim) is not `true` → disabled.
- File content (after trim) is exactly `true` → enabled.

Choosing a sidecar over `.env`:

- No coupling to the Zod-validated env schema in `src/utils/config.ts`.
- Tray apps already manage `.tray-lang`; the same I/O helpers apply.
- Live reads with no bot restart, identical to language switching.

## Bot side — `src/utils/skip-permissions.ts` (new)

A small helper module mirroring `src/utils/i18n.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAG_FILE = path.join(__dirname, "..", ".skip-permissions");

export function isSkipPermissionsEnabled(): boolean {
  try {
    return fs.readFileSync(FLAG_FILE, "utf-8").trim() === "true";
  } catch {
    return false;
  }
}
```

Read fresh each call. Errors (file missing, permission denied, junk
contents) all fall to `false` — safer default.

## Bot side — `src/claude/session-manager.ts`

The `runQuery` factory at the top of `sendMessage`
([src/claude/session-manager.ts:109-117](../../src/claude/session-manager.ts#L109-L117))
gains a fresh read of the toggle and passes it to the SDK:

```ts
const skipPerms = isSkipPermissionsEnabled();
const runQuery = (useResume: boolean) => query({
  prompt,
  options: {
    cwd: project.project_path,
    permissionMode: skipPerms ? "bypassPermissions" : "default",
    allowDangerouslySkipPermissions: skipPerms || undefined,
    env: { ... },                   // unchanged
    ...(useResume && resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(getConfig().CLAUDE_MODEL ? { model: getConfig().CLAUDE_MODEL } : {}),
    canUseTool: async (...) => { ... },  // unchanged; SDK skips it when bypassed
  },
});
```

`allowDangerouslySkipPermissions` is the SDK's required-when-bypass-mode
safety acknowledgement (see [`sdk.d.ts:1509`](../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L1509)).
Passing `undefined` when the flag is off matches the SDK's existing
"omit if not needed" convention used in the codebase for `resume` and
`model`.

`skipPerms` is captured once per `sendMessage` invocation, so resume
within the same message keeps a consistent mode. The next message rereads.

## Tray app — macOS (Swift)

`menubar/ClaudeBotMenu.swift` is the native menubar binary used on macOS.
Mirror the existing `autoStartItem` pattern
([menubar/ClaudeBotMenu.swift:462-465](../../menubar/ClaudeBotMenu.swift#L462-L465)):

```swift
let skipPermsItem = NSMenuItem(
    title: L("Skip Permissions (⚠️ dangerous)",
             "권한 건너뛰기 (⚠️ 위험)"),
    action: #selector(toggleSkipPermissions),
    keyEquivalent: "")
skipPermsItem.state = isSkipPermissionsEnabled() ? .on : .off
skipPermsItem.target = self
menu.addItem(skipPermsItem)
```

Add Swift helpers `isSkipPermissionsEnabled()` and
`toggleSkipPermissions()` that read/write `<botDir>/.skip-permissions`,
analogous to `isAutoStartEnabled()` / `toggleAutoStart()`.

First-enable confirmation: present an `NSAlert` with style `.warning`,
two buttons (Cancel / Enable), and message:

> "Skip Permissions will let Claude run any tool — including file writes,
> shell commands, and network calls — without confirmation. Continue?"

If Cancel: no-op. If Enable: write `true` to the sidecar and rebuild the
menu. Disabling does NOT prompt (moving back to the safe state needs no
friction).

After toggling, call the same menu-rebuild path that
`toggleAutoStart` uses so the checkmark state refreshes immediately.

## Tray app — Linux (Python pystray)

`tray/claude_tray.py` uses pystray. Mirror the autostart item
([tray/claude_tray.py:1161-1163](../../tray/claude_tray.py#L1161-L1163)):

```python
skip_perms_item = pystray.MenuItem(
    L("Skip Permissions (⚠️ dangerous)", "권한 건너뛰기 (⚠️ 위험)"),
    toggle_skip_permissions,
    checked=lambda item: is_skip_permissions_enabled()
)
```

Add module-level helpers reading/writing `<BOT_DIR>/.skip-permissions`.

First-enable confirmation: use `zenity --question` (with `--icon-name`
warning) or `yad` fallback — the existing `claude_tray.py` already uses
zenity/yad for the update confirmation dialog, so the helper is already
present and can be reused.

After toggling, set `icon.menu = create_menu()` to refresh — the existing
toggles do the same.

## Tray app — Windows (C#)

`tray/ClaudeBotTray.cs` uses WinForms `ToolStripMenuItem`. Mirror the
autostart item ([tray/ClaudeBotTray.cs:627-629](../../tray/ClaudeBotTray.cs#L627-L629)):

```csharp
var skipPermsItem = new ToolStripMenuItem(
    L("Skip Permissions (⚠️ dangerous)", "권한 건너뛰기 (⚠️ 위험)"));
skipPermsItem.Checked = IsSkipPermissionsEnabled();
skipPermsItem.Click += ToggleSkipPermissions;
```

Add `IsSkipPermissionsEnabled()` and `ToggleSkipPermissions(object,
EventArgs)` helpers reading/writing `<botDir>\.skip-permissions`.

First-enable confirmation: `MessageBox.Show(..., MessageBoxButtons.YesNo,
MessageBoxIcon.Warning)` with the same wording as macOS.

## Visual placement

In all three trays, place the new menu item immediately above the
existing **Auto Run on Startup** toggle so users find it in the same
visual region with the other "session-affecting toggles." Keep the ⚠️
emoji in the visible label so the menu state alone communicates the
risk.

## Safety summary

- ⚠️ in the menu label at all times when the item is visible.
- Confirmation dialog on first transition `false → true` in each tray.
- No confirmation needed for `true → false` (returning to safe default).
- Sidecar file's missing / unreadable / junk content all map to `false`.
- The SDK's own `allowDangerouslySkipPermissions: true` requirement is
  honoured so the bypass cannot happen by accident on the SDK side.

## What this design does NOT do

- No per-channel scope (explicit decision; user wanted global).
- No Discord-side command (explicit decision; tray-only).
- No audit log of tools run while bypassed (out of scope).
- No in-message inline override (e.g. message prefixes); the setting is
  the only knob.
- No automatic disable on bot upgrade — the user's choice persists.

## Documentation

`README.md` / `README.kr.md` gain a short ⚠️ section near where
`/auto-approve` is described, explaining what Skip Permissions does and
that the confirmation dialog only fires once per enable.
