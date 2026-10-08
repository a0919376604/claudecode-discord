import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { spawn } from "node:child_process";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("find-skills")
  .setDescription("Search agent skills from the open Skills registry (skills.sh)")
  .addStringOption((opt) =>
    opt
      .setName("query")
      .setDescription("Keywords, e.g. 'react performance' or 'pr review'")
      .setRequired(true)
      .setMaxLength(100),
  )
  .addStringOption((opt) =>
    opt
      .setName("owner")
      .setDescription("Restrict to a GitHub owner, e.g. 'vercel-labs'")
      .setRequired(false)
      .setMaxLength(64),
  );

const ANSI_RE = /\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

interface SkillsCliResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `npx --yes skills <args>` and capture ANSI-stripped output.
 * A modest timeout keeps a slow network from wedging the interaction —
 * Discord tokens die after ~15 minutes but users shouldn't wait that long.
 */
async function runSkills(
  args: string[],
  timeoutMs = 45_000,
): Promise<SkillsCliResult> {
  return new Promise<SkillsCliResult>((resolve) => {
    // CI=1 + TERM=dumb prevents the CLI from opening an interactive prompt
    // when the query has no results and prints a colour-free, deterministic
    // format we can parse line-by-line.
    const child = spawn("npx", ["--yes", "skills", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", TERM: "dumb", NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: SkillsCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
      settle({
        ok: false,
        code: -1,
        stdout: stripAnsi(stdout),
        stderr:
          stripAnsi(stderr) +
          `\nnpx skills ${args.join(" ")} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({
          ok: false,
          code: 127,
          stdout: "",
          stderr:
            "npx not found. Install Node.js (>= 18) to use the skills CLI.",
        });
        return;
      }
      settle({
        ok: false,
        code: 1,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr) + `\nspawn error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      settle({
        ok: exitCode === 0,
        code: exitCode,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
      });
    });
  });
}

export interface SkillHit {
  pkg: string;      // e.g. "vercel-labs/agent-skills@vercel-react-best-practices"
  installs: string; // e.g. "610.3K installs" — kept verbatim from CLI
  url: string;      // https://skills.sh/...
}

/**
 * Parse the paired output of `npx skills find`:
 *
 *     vercel-labs/agent-skills@vercel-react-best-practices 610.3K installs
 *     └ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices
 *
 * Robust against the header line and blank lines. Exported for tests.
 */
export function parseFindOutput(raw: string): SkillHit[] {
  const hits: SkillHit[] = [];
  const lines = raw.split(/\r?\n/);
  const HEADER_RE = /^([^\s]+\/[^\s@]+@[^\s]+)\s+(\d[\d.,KMB]*\s+installs?)\s*$/;
  const URL_RE = /^└\s+(https?:\/\/\S+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_RE);
    if (!m) continue;
    // Find the next non-empty line that looks like a URL row.
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      const um = t.match(URL_RE);
      if (um) url = um[1];
      break;
    }
    hits.push({ pkg: m[1], installs: m[2], url });
  }
  return hits;
}

const MAX_RESULTS = 10;

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query = interaction.options.getString("query", true).trim();
  const owner = interaction.options.getString("owner")?.trim() || "";

  if (!query) {
    await interaction.editReply({
      content: L("Query is required.", "검색어를 입력하세요."),
    });
    return;
  }

  const args = ["find", query];
  if (owner) args.push("--owner", owner);

  const result = await runSkills(args);

  if (!result.ok && result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 1500);
    await interaction.editReply({
      content:
        L(
          `\`npx skills find\` failed (exit ${result.code}).`,
          `\`npx skills find\` 실행 실패 (종료 코드 ${result.code}).`,
        ) + (detail ? `\n\`\`\`\n${detail}\n\`\`\`` : ""),
    });
    return;
  }

  const hits = parseFindOutput(result.stdout);

  if (hits.length === 0) {
    const scope = owner ? ` (owner=${owner})` : "";
    await interaction.editReply({
      content: L(
        `No skills matched **${query}**${scope}. Browse at https://skills.sh/`,
        `**${query}**${scope}에 매칭되는 스킬이 없습니다. https://skills.sh/ 에서 둘러보세요.`,
      ),
    });
    return;
  }

  const shown = hits.slice(0, MAX_RESULTS);
  const remaining = hits.length - shown.length;

  const description = shown
    .map((h, i) => {
      const line1 = `**${i + 1}. \`${h.pkg}\`** · ${h.installs}`;
      const line2 = h.url ? `<${h.url}>` : "";
      const line3 = `\`npx skills add ${h.pkg} -g -y\``;
      return [line1, line2, line3].filter(Boolean).join("\n");
    })
    .join("\n\n");

  const footer = remaining > 0
    ? L(
        `+${remaining} more · Browse all at https://skills.sh/`,
        `+${remaining}개 더 · 전체 목록: https://skills.sh/`,
      )
    : L("Browse all at https://skills.sh/", "전체 목록: https://skills.sh/");

  const embed = new EmbedBuilder()
    .setTitle(
      L(
        `Skills matching “${query}”${owner ? ` (owner: ${owner})` : ""}`,
        `“${query}” 검색 결과${owner ? ` (owner: ${owner})` : ""}`,
      ),
    )
    .setDescription(description.slice(0, 4000)) // Discord embed description limit is 4096
    .setColor(0x5865f2)
    .setFooter({ text: footer });

  await interaction.editReply({ embeds: [embed] });
}
