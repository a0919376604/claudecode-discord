import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { L } from "../../utils/i18n.js";

/**
 * /refresh-board <repo> [hours]
 *
 * Re-runs the obsidian-second-brain daily board refresh for a single repo.
 * Updates the vault board (English, AI-first) and mirrors a Chinese version
 * to Notion. The actual work happens in
 *   ~/.config/obsidian-second-brain/daily-board-refresh.sh
 * which is the same script launchd fires every day at 09:00.
 *
 * `repo` has dynamic autocomplete: scans CODE_ROOT (default ~/Desktop/code)
 * for sibling directories whose `.git` is a real directory (not a worktree
 * pointer file — worktrees share their parent's history and would refresh
 * the same board twice).
 */

function codeRoot(): string {
  return process.env.CODE_ROOT || path.join(os.homedir(), "Desktop", "code");
}
function scriptPath(): string {
  return (
    process.env.OBSIDIAN_BOARD_REFRESH_SCRIPT ||
    path.join(os.homedir(), ".config", "obsidian-second-brain", "daily-board-refresh.sh")
  );
}
const MAIN_LOG = "/tmp/obsidian-board-refresh.log";
const MAX_WAIT_MS = 9 * 60 * 1000; // 9 min — Discord's deferReply lasts ~15 min

// Repo names must be plain basenames. Reject anything that could be a path
// traversal (`..`, leading `.`, `/`), shell metacharacter, or whitespace.
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isValidRepoName(name: string): boolean {
  if (!REPO_NAME_RE.test(name)) return false;
  if (name === "..") return false;
  if (name.includes("..")) return false; // belt-and-suspenders against `..something`
  return true;
}

export const data = new SlashCommandBuilder()
  .setName("refresh-board")
  .setDescription("Refresh vault + Notion board for one repo")
  .addStringOption((opt) =>
    opt
      .setName("repo")
      .setDescription(`Repo basename under ${codeRoot()}`)
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("hours")
      .setDescription("Git activity window in hours (default 168 = 7 days)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(8760),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

/**
 * List repos under CODE_ROOT eligible for refresh: directory + `.git` subdir
 * (excludes worktree siblings, where `.git` is a regular file).
 */
function listEligibleRepos(): string[] {
  const root = codeRoot();
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .filter((e) => {
        try {
          const gitPath = path.join(root, e.name, ".git");
          return fs.statSync(gitPath).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();

  const repos = listEligibleRepos()
    .filter((name) => !focused || name.toLowerCase().includes(focused))
    .slice(0, 25);

  await interaction.respond(
    repos.map((name) => ({ name, value: name })),
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true).trim();
  const hours = interaction.options.getInteger("hours") ?? 168;

  // Validate repo name — no path traversal, no shell metacharacters
  if (!isValidRepoName(repo)) {
    await interaction.editReply({
      content: L(
        `Invalid repo name \`${repo}\` — only letters, digits, dot, underscore, dash allowed; cannot start with dot or contain '..'.`,
        `잘못된 repo 이름 \`${repo}\` — 영문/숫자/./_/- 만 허용되며, 점으로 시작하거나 '..'을 포함할 수 없습니다.`,
      ),
    });
    return;
  }

  const repoPath = path.join(codeRoot(), repo);
  const gitPath = path.join(repoPath, ".git");
  if (!fs.existsSync(repoPath) || !fs.existsSync(gitPath)) {
    await interaction.editReply({
      content: L(
        `Repo not found: \`${repoPath}\``,
        `Repo를 찾을 수 없습니다: \`${repoPath}\``,
      ),
    });
    return;
  }
  if (!fs.statSync(gitPath).isDirectory()) {
    await interaction.editReply({
      content: L(
        `\`${repo}\` is a git worktree — refresh its parent repo instead.`,
        `\`${repo}\`는 git worktree입니다 — 상위 repo를 새로 고치세요.`,
      ),
    });
    return;
  }

  const SCRIPT = scriptPath();
  if (!fs.existsSync(SCRIPT)) {
    await interaction.editReply({
      content: L(
        `Refresh script not found at \`${SCRIPT}\`. Install obsidian-second-brain first.`,
        `Refresh 스크립트를 찾을 수 없습니다: \`${SCRIPT}\`. 먼저 obsidian-second-brain을 설치하세요.`,
      ),
    });
    return;
  }

  const startedAt = Date.now();
  await interaction.editReply({
    content: L(
      `🔄 Refreshing **${repo}** (window: ${hours}h)…\nlogs: \`${MAIN_LOG}\``,
      `🔄 **${repo}** 새로 고침 중 (창: ${hours}h)…\n로그: \`${MAIN_LOG}\``,
    ),
  });

  // Run the script attached so we know exactly when it finishes. The bot's
  // process owns it — if the bot restarts mid-run, the script is interrupted
  // and the user can just re-invoke. Idempotent reruns are safe.
  const result = await runRefresh(repo, hours);

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  if (result.timedOut) {
    await interaction.editReply({
      content: L(
        `⏱️ Still running after ${Math.round(MAX_WAIT_MS / 60000)} min. Check \`${MAIN_LOG}\` for progress.`,
        `⏱️ ${Math.round(MAX_WAIT_MS / 60000)}분 후에도 실행 중. \`${MAIN_LOG}\`를 확인하세요.`,
      ),
    });
    return;
  }

  if (result.exitCode !== 0) {
    await interaction.editReply({
      content: L(
        `❌ Refresh failed (exit=${result.exitCode}) for **${repo}** after ${elapsedSec}s.\n` +
          `Last log lines:\n\`\`\`\n${result.logTail.slice(-1500)}\n\`\`\``,
        `❌ **${repo}** 새로 고침 실패 (exit=${result.exitCode}, ${elapsedSec}초).\n` +
          `최근 로그:\n\`\`\`\n${result.logTail.slice(-1500)}\n\`\`\``,
      ),
    });
    return;
  }

  const summary = parseSummary(repo);
  await interaction.editReply({
    content: L(
      `✅ Refreshed **${repo}** in ${elapsedSec}s\n` +
        `• vault: ${summary.vault}\n` +
        `• notion: ${summary.notion}` +
        (summary.notionUrl ? `\n• link: ${summary.notionUrl}` : ""),
      `✅ **${repo}** 새로 고침 완료 (${elapsedSec}초)\n` +
        `• vault: ${summary.vault}\n` +
        `• notion: ${summary.notion}` +
        (summary.notionUrl ? `\n• 링크: ${summary.notionUrl}` : ""),
    ),
  });
}

interface RefreshResult {
  exitCode: number | null;
  timedOut: boolean;
  logTail: string;
}

function runRefresh(repo: string, hours: number): Promise<RefreshResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "bash",
      [scriptPath(), "--repo", repo, "--since", String(hours)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    // We don't actually care about stdout (the script writes to MAIN_LOG)
    // but we still drain it to prevent the pipe filling up.
    child.stdout.on("data", () => {});

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve({ exitCode: null, timedOut: true, logTail: tailLog() });
    }, MAX_WAIT_MS);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut: false,
        logTail: tailLog() + (stderr ? `\n[stderr]\n${stderr}` : ""),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut: false,
        logTail: `[spawn error] ${err.message}`,
      });
    });
  });
}

function tailLog(): string {
  try {
    const buf = fs.readFileSync(MAIN_LOG, "utf8");
    const lines = buf.split("\n");
    return lines.slice(-30).join("\n");
  } catch {
    return "(log not readable)";
  }
}

/**
 * Parse the last `===== run ... summary =====` block out of MAIN_LOG and the
 * NOTION_URL line from the per-repo claude transcript. Returns short status
 * strings ready to drop into a Discord message.
 */
function parseSummary(repo: string): {
  vault: string;
  notion: string;
  notionUrl: string | null;
} {
  let logText = "";
  try {
    logText = fs.readFileSync(MAIN_LOG, "utf8");
  } catch {
    return { vault: "?", notion: "?", notionUrl: null };
  }

  // Find the LAST summary block in the file (most recent run).
  const blocks = logText.split(/===== run [\d-]+ summary =====/);
  const lastBlock = blocks[blocks.length - 1] || "";

  const grab = (label: string): string => {
    const m = lastBlock.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "(no info)";
  };

  const vaultUpdated = grab("vault updated");
  const vaultFailed = grab("vault failed");
  const vaultSkipped = grab("vault skipped");
  let vault: string;
  if (vaultUpdated.includes(repo)) vault = "updated";
  else if (vaultFailed.includes(repo)) vault = `failed (${vaultFailed})`;
  else if (vaultSkipped.includes(repo)) vault = `skipped (${vaultSkipped})`;
  else vault = "unknown";

  const notionUpdated = grab("notion updated");
  const notionFailed = grab("notion failed");
  const notionSkipped = grab("notion skipped");
  let notion: string;
  if (notionUpdated.includes(repo)) notion = "updated";
  else if (notionFailed.includes(repo)) notion = `failed (${notionFailed})`;
  else if (notionSkipped.includes(repo)) notion = `skipped (${notionSkipped})`;
  else notion = "unknown";

  // Notion URL is logged by the per-repo claude transcript.
  let notionUrl: string | null = null;
  try {
    const notionOut = fs.readFileSync(
      `/tmp/obsidian-board-refresh.${repo}.notion.out`,
      "utf8",
    );
    const m = notionOut.match(/NOTION_URL:\s*(\S+)/);
    if (m) notionUrl = m[1];
  } catch {
    /* no transcript — leave null */
  }

  return { vault, notion, notionUrl };
}

// Exported for unit tests
export const __testing = { listEligibleRepos, parseSummary, isValidRepoName, REPO_NAME_RE };
