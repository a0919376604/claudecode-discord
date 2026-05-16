# Skip Permissions Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global tray-app toggle that flips the Agent SDK's `permissionMode` to `bypassPermissions`, so trusted users can run Claude without any approval prompts.

**Architecture:** A sidecar file `<botDir>/.skip-permissions` holds the on/off state. The Node bot reads it fresh at the start of every Claude query via a new `src/utils/skip-permissions.ts` helper and sets `permissionMode` + `allowDangerouslySkipPermissions` accordingly. Each of the three tray apps (macOS Swift, Linux Python, Windows C#) gets a checkable menu item that writes the sidecar and rebuilds its menu. First-enable in each tray prompts a platform-native confirmation dialog; disabling is unconfirmed.

**Tech Stack:** TypeScript ESM (vitest), Swift / AppKit, Python / pystray + zenity, C# / WinForms. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-16-skip-permissions-toggle-design.md`](../specs/2026-05-16-skip-permissions-toggle-design.md)

---

## File Structure

**Create:**
- `src/utils/skip-permissions.ts` — reads the sidecar and exposes `isSkipPermissionsEnabled(filePath?)`. Optional `filePath` parameter exists purely for testability; production code calls it with no args.
- `src/utils/skip-permissions.test.ts` — vitest cases against temp files.

**Modify:**
- `src/claude/session-manager.ts` — wire `isSkipPermissionsEnabled()` into `runQuery`'s `permissionMode` + `allowDangerouslySkipPermissions`.
- `menubar/ClaudeBotMenu.swift` — add helpers + menu item + NSAlert.
- `tray/claude_tray.py` — add helpers + pystray MenuItem + zenity dialog.
- `tray/ClaudeBotTray.cs` — add helpers + ToolStripMenuItem + MessageBox.
- `README.md`, `README.kr.md` — short ⚠️ section.

**Conventions to follow throughout:**

- All TS imports use `.js` extensions (ESM).
- All user-facing strings use `L(en, kr)` in TS / Swift / Python / C#.
- Read sidecar fresh on each access. Any read error → return `false`.
- Sidecar is written atomically (write to temp + rename) only if straightforward in the platform; otherwise a simple overwrite is acceptable because the file is small and not safety-critical to its own writers.

---

## Task 1: Bot helper + integration

**Files:**
- Create: `src/utils/skip-permissions.ts`
- Create: `src/utils/skip-permissions.test.ts`
- Modify: `src/claude/session-manager.ts:109-117`

- [ ] **Step 1.1: Write failing tests**

Create `src/utils/skip-permissions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isSkipPermissionsEnabled } from "./skip-permissions.js";

let tmpDir: string;
let flagPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skip-perms-"));
  flagPath = path.join(tmpDir, ".skip-permissions");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isSkipPermissionsEnabled", () => {
  it("returns false when file does not exist", () => {
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns true when file content (trimmed) is exactly 'true'", () => {
    fs.writeFileSync(flagPath, "true\n");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(true);
  });

  it("returns false when file content is 'false'", () => {
    fs.writeFileSync(flagPath, "false");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns false when file content is anything other than 'true'", () => {
    fs.writeFileSync(flagPath, "yes");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns false when content trims to empty", () => {
    fs.writeFileSync(flagPath, "   \n  \n");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns false when the file is unreadable (path is a directory)", () => {
    expect(isSkipPermissionsEnabled(tmpDir)).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run test and watch it fail**

Run: `npx vitest run src/utils/skip-permissions.test.ts`
Expected: FAIL — module `./skip-permissions.js` does not exist.

- [ ] **Step 1.3: Implement the helper**

Create `src/utils/skip-permissions.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolves to <botDir>/.skip-permissions when running from dist/index.js.
// Exported so the tray apps' documentation can reference the same path
// without hardcoding it elsewhere in TS.
export const SKIP_PERMISSIONS_FILE = path.join(__dirname, "..", ".skip-permissions");

/**
 * Returns true if the sidecar file at `filePath` (defaults to
 * `<botDir>/.skip-permissions`) contains exactly `true` (after trim).
 * Any read error, missing file, or other content returns false — safer default.
 */
export function isSkipPermissionsEnabled(filePath: string = SKIP_PERMISSIONS_FILE): boolean {
  try {
    return fs.readFileSync(filePath, "utf-8").trim() === "true";
  } catch {
    return false;
  }
}
```

- [ ] **Step 1.4: Run test and watch it pass**

Run: `npx vitest run src/utils/skip-permissions.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 1.5: Wire into `session-manager.ts`**

Open `src/claude/session-manager.ts`. At the top of the file, add the import alongside the existing imports:

```typescript
import { isSkipPermissionsEnabled } from "../utils/skip-permissions.js";
```

Then locate `runQuery` (currently around line 109). Replace this block:

```typescript
    const runQuery = (useResume: boolean) => query({
      prompt,
      options: {
        cwd: project.project_path,
        permissionMode: "default",
        env: { ...process.env, ANTHROPIC_API_KEY: undefined, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        ...(useResume && resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(getConfig().CLAUDE_MODEL ? { model: getConfig().CLAUDE_MODEL } : {}),
```

with:

```typescript
    const skipPerms = isSkipPermissionsEnabled();
    const runQuery = (useResume: boolean) => query({
      prompt,
      options: {
        cwd: project.project_path,
        permissionMode: skipPerms ? "bypassPermissions" : "default",
        ...(skipPerms ? { allowDangerouslySkipPermissions: true } : {}),
        env: { ...process.env, ANTHROPIC_API_KEY: undefined, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        ...(useResume && resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(getConfig().CLAUDE_MODEL ? { model: getConfig().CLAUDE_MODEL } : {}),
```

Notes:
- `skipPerms` is captured *once* per `sendMessage` invocation (i.e. just before `runQuery` is defined) so resume retries inside the same message stay in the same permission mode.
- `allowDangerouslySkipPermissions: true` is only set when `skipPerms` is true — the SDK requires it when using `bypassPermissions` and otherwise should be omitted.

- [ ] **Step 1.6: Type-check + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; existing 109 tests still pass plus 6 new tests in `skip-permissions.test.ts` (total 115).

- [ ] **Step 1.7: Commit**

```bash
git add src/utils/skip-permissions.ts src/utils/skip-permissions.test.ts src/claude/session-manager.ts
git commit -m "Add skip-permissions toggle helper and wire into session-manager"
```

---

## Task 2: macOS tray — Swift menubar

**Files:**
- Modify: `menubar/ClaudeBotMenu.swift` (helpers near `isAutoStartEnabled`, menu item inside `buildMenu` near line 462, NSAlert in the toggle handler)

**No unit tests** — this codebase has no Swift test harness. Manual verification at the end of the task.

- [ ] **Step 2.1: Add the file-path constant near the existing `langPrefFile`**

In `ClaudeBotMenu.swift`, find the property block around line 39 that includes:

```swift
langPrefFile = botDir + "/.tray-lang"
```

Right below it, add:

```swift
skipPermsFile = botDir + "/.skip-permissions"
```

And add the matching property declaration near `langPrefFile`'s declaration (search for `var langPrefFile: String` and add `var skipPermsFile: String` next to it).

- [ ] **Step 2.2: Add helpers near `isAutoStartEnabled` / `toggleAutoStart`**

Find `private func isAutoStartEnabled()` in the file. Add these two functions immediately after `toggleAutoStart`:

```swift
    private func isSkipPermissionsEnabled() -> Bool {
        guard let contents = try? String(contentsOfFile: skipPermsFile, encoding: .utf8) else {
            return false
        }
        return contents.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    @objc private func toggleSkipPermissions() {
        let currentlyOn = isSkipPermissionsEnabled()
        if !currentlyOn {
            // Confirm only when turning ON (false → true).
            let alert = NSAlert()
            alert.messageText = L("Enable Skip Permissions?",
                                  "권한 건너뛰기를 활성화하시겠습니까?")
            alert.informativeText = L(
                "Skip Permissions lets Claude run any tool — including file writes, shell commands, and network calls — without confirmation. Continue?",
                "권한 건너뛰기를 켜면 Claude가 파일 쓰기, 셸 명령, 네트워크 호출을 포함한 모든 도구를 확인 없이 실행합니다. 계속할까요?"
            )
            alert.alertStyle = .warning
            alert.addButton(withTitle: L("Cancel", "취소"))
            alert.addButton(withTitle: L("Enable", "활성화"))
            // First button (Cancel) = .alertFirstButtonReturn = 1000
            // Second button (Enable) = .alertSecondButtonReturn = 1001
            let response = alert.runModal()
            guard response == .alertSecondButtonReturn else { return }
            writeSkipPermsFlag(true)
        } else {
            writeSkipPermsFlag(false)
        }
        buildMenu()
    }

    private func writeSkipPermsFlag(_ enabled: Bool) {
        let content = enabled ? "true" : "false"
        try? content.write(toFile: skipPermsFile, atomically: true, encoding: .utf8)
    }
```

- [ ] **Step 2.3: Add the menu item**

Find this block in `buildMenu` (around line 462):

```swift
        menu.addItem(NSMenuItem.separator())

        // Auto-start toggle
        let autoStartItem = NSMenuItem(title: L("Launch on System Startup", "시스템 시작 시 자동 실행"), action: #selector(toggleAutoStart), keyEquivalent: "")
        autoStartItem.target = self
        autoStartItem.state = isAutoStartEnabled() ? .on : .off
        menu.addItem(autoStartItem)
```

Insert the new item BEFORE `autoStartItem`:

```swift
        menu.addItem(NSMenuItem.separator())

        // Skip Permissions toggle (dangerous)
        let skipPermsItem = NSMenuItem(
            title: L("Skip Permissions (⚠️ dangerous)",
                     "권한 건너뛰기 (⚠️ 위험)"),
            action: #selector(toggleSkipPermissions),
            keyEquivalent: "")
        skipPermsItem.target = self
        skipPermsItem.state = isSkipPermissionsEnabled() ? .on : .off
        menu.addItem(skipPermsItem)

        // Auto-start toggle
        let autoStartItem = NSMenuItem(title: L("Launch on System Startup", "시스템 시작 시 자동 실행"), action: #selector(toggleAutoStart), keyEquivalent: "")
        autoStartItem.target = self
        autoStartItem.state = isAutoStartEnabled() ? .on : .off
        menu.addItem(autoStartItem)
```

- [ ] **Step 2.4: Rebuild the Swift binary**

The compiled binary `menubar/ClaudeBotMenu` is committed to the repo. Rebuild it:

```bash
cd menubar
swiftc -o ClaudeBotMenu ClaudeBotMenu.swift -framework Cocoa -framework AppKit
cd ..
```

Expected: clean build, no warnings/errors. The binary `menubar/ClaudeBotMenu` is updated in place.

If `swiftc` is not on PATH, run `xcrun swiftc ...` instead.

- [ ] **Step 2.5: Manual smoke test (macOS only)**

1. Start the menubar app: `./mac-start.sh`
2. Click the menubar icon — confirm the new "Skip Permissions (⚠️ dangerous)" item appears just above "Launch on System Startup", with no checkmark.
3. Click it. Confirm the NSAlert appears with Cancel/Enable buttons and warning copy.
4. Click Cancel — the checkmark should stay off.
5. Click again, choose Enable — the checkmark should turn on.
6. Verify: `cat .skip-permissions` → outputs `true`.
7. Click again — no dialog, checkmark turns off.
8. Verify: `cat .skip-permissions` → outputs `false`.

- [ ] **Step 2.6: Commit**

```bash
git add menubar/ClaudeBotMenu.swift menubar/ClaudeBotMenu
git commit -m "Add Skip Permissions toggle to macOS menubar"
```

---

## Task 3: Linux tray — Python pystray

**Files:**
- Modify: `tray/claude_tray.py` (helpers near line 595, menu item near line 1161, sidecar path near line 27)

**No unit tests** — manual verification at end.

- [ ] **Step 3.1: Add the sidecar path constant**

Find these lines near the top of `tray/claude_tray.py`:

```python
ENV_PATH = os.path.join(BOT_DIR, ".env")
LANG_PREF_FILE = os.path.join(BOT_DIR, ".tray-lang")
```

Add immediately after:

```python
SKIP_PERMS_FILE = os.path.join(BOT_DIR, ".skip-permissions")
```

- [ ] **Step 3.2: Add helpers near `is_autostart_enabled` / `toggle_autostart`**

Find `def is_autostart_enabled():` (around line 595). Add these two functions immediately before it:

```python
def is_skip_permissions_enabled():
    try:
        with open(SKIP_PERMS_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() == "true"
    except Exception:
        return False


def toggle_skip_permissions(icon, item):
    currently_on = is_skip_permissions_enabled()
    if not currently_on:
        # Confirm only when turning ON.
        title = L("Enable Skip Permissions?",
                  "권한 건너뛰기를 활성화하시겠습니까?")
        msg = L(
            "Skip Permissions lets Claude run any tool — including file writes, shell commands, and network calls — without confirmation. Continue?",
            "권한 건너뛰기를 켜면 Claude가 파일 쓰기, 셸 명령, 네트워크 호출을 포함한 모든 도구를 확인 없이 실행합니다. 계속할까요?"
        )
        # Returncode 0 = yes, anything else = no/cancelled
        result = subprocess.run(
            ["zenity", "--question", "--title=" + title, "--text=" + msg,
             "--ok-label=" + L("Enable", "활성화"),
             "--cancel-label=" + L("Cancel", "취소")],
            check=False,
        )
        if result.returncode != 0:
            icon.menu = create_menu()
            return
        _write_skip_perms(True)
    else:
        _write_skip_perms(False)
    icon.menu = create_menu()


def _write_skip_perms(enabled):
    try:
        with open(SKIP_PERMS_FILE, "w", encoding="utf-8") as f:
            f.write("true" if enabled else "false")
    except Exception:
        pass
```

- [ ] **Step 3.3: Add the menu item**

Find this block in `create_menu()` (around line 1161):

```python
    autostart_item = pystray.MenuItem(
        L("Auto-start on Boot", "부팅 시 자동 실행"),
        toggle_autostart, checked=lambda item: is_autostart_enabled()
    )
```

Add this declaration *before* `autostart_item`:

```python
    skip_perms_item = pystray.MenuItem(
        L("Skip Permissions (⚠️ dangerous)",
          "권한 건너뛰기 (⚠️ 위험)"),
        toggle_skip_permissions,
        checked=lambda item: is_skip_permissions_enabled()
    )
```

Then find where `autostart_item` is added to the menu tuple (search downstream of the declaration; it appears inside a `pystray.Menu(...)` constructor or a tuple of items). Add `skip_perms_item` to the same tuple/menu, immediately before `autostart_item`.

- [ ] **Step 3.4: Manual smoke test (Linux only)**

1. Start the tray: `python3 tray/claude_tray.py` (or via `./linux-start.sh`).
2. Right-click the tray icon — confirm the new "Skip Permissions (⚠️ dangerous)" item appears just before "Auto-start on Boot", unchecked.
3. Click it — confirm a zenity dialog asks for confirmation with Cancel/Enable buttons.
4. Click Cancel → checkmark stays off, `cat .skip-permissions` returns "false" or file is missing.
5. Click again, choose Enable → checkmark turns on, `cat .skip-permissions` → `true`.
6. Click once more (now ON) → no dialog, checkmark turns off, `cat .skip-permissions` → `false`.

If zenity isn't installed in the test environment, the dialog spawn will fail. The plan assumes zenity is available because the existing update-confirmation flow at line 257 of `claude_tray.py` already depends on it.

- [ ] **Step 3.5: Commit**

```bash
git add tray/claude_tray.py
git commit -m "Add Skip Permissions toggle to Linux tray"
```

---

## Task 4: Windows tray — C#

**Files:**
- Modify: `tray/ClaudeBotTray.cs` (sidecar path near line 57, helpers near `IsAutoStartEnabled`/`ToggleAutoStart` near line 792, menu item near line 627)

**No unit tests** — manual verification at end.

- [ ] **Step 4.1: Add the sidecar path**

Find this line near line 57:

```csharp
langPrefFile = Path.Combine(botDir, ".tray-lang");
```

Add immediately after:

```csharp
skipPermsFile = Path.Combine(botDir, ".skip-permissions");
```

Also add the field declaration in the matching declarations block (search for `private string langPrefFile;` and add `private string skipPermsFile;` next to it).

- [ ] **Step 4.2: Add helpers near `IsAutoStartEnabled` / `ToggleAutoStart`**

Find `private bool IsAutoStartEnabled()` around line 792. Add these methods immediately before it:

```csharp
    private bool IsSkipPermissionsEnabled()
    {
        try
        {
            if (!File.Exists(skipPermsFile)) return false;
            string contents = File.ReadAllText(skipPermsFile).Trim();
            return contents == "true";
        }
        catch { return false; }
    }

    private void ToggleSkipPermissions(object sender, EventArgs e)
    {
        bool currentlyOn = IsSkipPermissionsEnabled();
        if (!currentlyOn)
        {
            // Confirm only when turning ON.
            string title = L("Enable Skip Permissions?",
                             "권한 건너뛰기를 활성화하시겠습니까?");
            string msg = L(
                "Skip Permissions lets Claude run any tool — including file writes, shell commands, and network calls — without confirmation. Continue?",
                "권한 건너뛰기를 켜면 Claude가 파일 쓰기, 셸 명령, 네트워크 호출을 포함한 모든 도구를 확인 없이 실행합니다. 계속할까요?"
            );
            var result = MessageBox.Show(msg, title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (result != DialogResult.Yes)
            {
                BuildMenu();
                return;
            }
            WriteSkipPermsFlag(true);
        }
        else
        {
            WriteSkipPermsFlag(false);
        }
        BuildMenu();
    }

    private void WriteSkipPermsFlag(bool enabled)
    {
        try { File.WriteAllText(skipPermsFile, enabled ? "true" : "false"); }
        catch { }
    }
```

- [ ] **Step 4.3: Add the menu item**

Find this block around line 627:

```csharp
        var autoStartItem = new ToolStripMenuItem(L("Auto Run on Startup", "시작 시 자동 실행"));
        autoStartItem.Checked = IsAutoStartEnabled();
        autoStartItem.Click += ToggleAutoStart;
```

Add the new item *immediately before* `autoStartItem`:

```csharp
        var skipPermsItem = new ToolStripMenuItem(
            L("Skip Permissions (⚠️ dangerous)",
              "권한 건너뛰기 (⚠️ 위험)"));
        skipPermsItem.Checked = IsSkipPermissionsEnabled();
        skipPermsItem.Click += ToggleSkipPermissions;
```

Then find where `autoStartItem` is added to the menu (search for `menu.Items.Add(autoStartItem)` or similar). Add `menu.Items.Add(skipPermsItem)` immediately before that line.

- [ ] **Step 4.4: Manual smoke test (Windows only)**

1. Build / run the tray (existing process — the `win-start.bat` launcher and the existing C# build steps).
2. Right-click the tray icon — confirm the new "Skip Permissions (⚠️ dangerous)" item appears above "Auto Run on Startup", unchecked.
3. Click it — confirm a MessageBox appears with warning icon, Yes/No buttons, and the bilingual copy.
4. Click No → checkmark stays off, `type .skip-permissions` shows the file does not exist (or contains "false").
5. Click again, choose Yes → checkmark turns on, `type .skip-permissions` outputs `true`.
6. Click once more → no dialog, checkmark turns off, file contains `false`.

- [ ] **Step 4.5: Commit**

```bash
git add tray/ClaudeBotTray.cs
git commit -m "Add Skip Permissions toggle to Windows tray"
```

---

## Task 5: Documentation

**Files:**
- Modify: `README.md`, `README.kr.md` (or whichever is the bot's main README)

- [ ] **Step 5.1: Find the right place in `README.md`**

Search `README.md` for the section that documents `/auto-approve` (likely under "Commands" or "Slash Commands"). Add a new ⚠️ section immediately after it.

- [ ] **Step 5.2: Add the section to `README.md`**

```markdown
### ⚠️ Skip Permissions (tray toggle)

The system tray menu has a **Skip Permissions** toggle. Enabling it makes
the bot launch Claude with `permissionMode: 'bypassPermissions'`, which is
equivalent to passing `--dangerously-skip-permissions` to the Claude CLI.

When enabled:

- Write tools (Edit, Write, Bash, etc.) run without Discord approval buttons.
- The bot's `AskUserQuestion` popups do not appear — Claude decides on its own.
- Per-tool cost embeds do not appear; session-end totals still do.

This is **global** (affects every registered channel), persists across
restarts, and takes effect on the next Claude session after toggling. The
first time you enable it the tray asks for confirmation; turning it off is
immediate.

Only enable this on a machine you trust and for projects you would let
Claude modify without supervision.
```

- [ ] **Step 5.3: Mirror the section in `README.kr.md`**

```markdown
### ⚠️ 권한 건너뛰기 (트레이 토글)

시스템 트레이 메뉴에 **권한 건너뛰기** 토글이 있습니다. 활성화하면 봇이
`permissionMode: 'bypassPermissions'`로 Claude를 실행합니다. 이는 Claude
CLI의 `--dangerously-skip-permissions` 플래그와 동일합니다.

활성화 시:

- 쓰기 도구(Edit, Write, Bash 등)가 Discord 승인 버튼 없이 실행됩니다.
- 봇의 `AskUserQuestion` 팝업이 표시되지 않고, Claude가 직접 결정합니다.
- 도구별 비용 임베드가 표시되지 않습니다. 세션 종료 시 총합은 여전히 표시됩니다.

이 설정은 **전역**이며(모든 등록된 채널에 적용), 재시작 후에도 유지되고,
토글 후 다음 Claude 세션부터 적용됩니다. 처음 활성화할 때만 트레이가 확인을
요구하며, 끌 때는 바로 적용됩니다.

신뢰할 수 있는 머신, 그리고 감독 없이 Claude가 수정해도 되는 프로젝트에서만
활성화하세요.
```

- [ ] **Step 5.4: Commit**

```bash
git add README.md README.kr.md
git commit -m "Document the Skip Permissions tray toggle"
```

---

## Self-Review Notes

- **Spec coverage:** Sidecar file (Task 1.3), bot read/integration (Task 1.5), macOS Swift menu + NSAlert (Task 2), Linux pystray + zenity (Task 3), Windows ToolStripMenuItem + MessageBox (Task 4), README docs (Task 5). The spec's "Visual placement: above Auto Run on Startup" is honored in all three trays. The spec's "first-enable confirmation only" rule is honored in all three trays. The spec's "any read error → false" rule is implemented in `skip-permissions.ts` (Task 1.3) and mirrored in Swift/Python/C# helpers.
- **No placeholders:** All steps contain runnable code or specific commands. The only thing left to the implementer's judgment is the exact line at which the new menu item is appended into each tray's menu tuple — that's an editorial pointer, not a placeholder.
- **Type/name consistency:** `isSkipPermissionsEnabled` in TS / Swift, `is_skip_permissions_enabled` in Python, `IsSkipPermissionsEnabled` in C# — language-appropriate casing of the same name. Toggle pair (`toggleSkipPermissions` / `toggle_skip_permissions` / `ToggleSkipPermissions`). All three trays read/write the same file path (`<botDir>/.skip-permissions`).
- **Known compromise:** No automated tests for the three tray apps — this codebase has no Swift/Python/C# test harness. Manual smoke steps are spelled out per platform. Bot-side helper and SDK integration ARE unit-tested.
