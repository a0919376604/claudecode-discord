import { exec } from "node:child_process";
import { promisify } from "node:util";
import { L } from "../utils/i18n.js";

const execAsync = promisify(exec);

export interface CodexDetection {
  ok: boolean;
  errorMessage: string;
}

let cached: CodexDetection | null = null;

/** Test-only reset. */
export function _clearCache(): void {
  cached = null;
}

const INSTALL_HINT_EN =
  "❌ **Codex CLI not found.**\n\n" +
  "Install it first:\n```\nnpm install -g @openai/codex\n```\n" +
  "Or with Homebrew (macOS):\n```\nbrew install codex\n```\n" +
  "[Official install docs](https://github.com/openai/codex)";
const INSTALL_HINT_KR =
  "❌ **Codex CLI가 설치되어 있지 않습니다.**\n\n" +
  "먼저 설치하세요:\n```\nnpm install -g @openai/codex\n```\n" +
  "또는 Homebrew (macOS):\n```\nbrew install codex\n```\n" +
  "[공식 설치 문서](https://github.com/openai/codex)";

const RUN_FAIL_EN = "❌ Codex CLI is installed but not runnable. Try reinstalling.";
const RUN_FAIL_KR = "❌ Codex CLI가 실행되지 않습니다. 재설치를 시도하세요.";

const LOGIN_HINT_EN =
  "🔑 **Codex is not logged in.**\n\n" +
  "On the host PC, open a terminal and run:\n```\ncodex login\n```\n" +
  "Then try again. (Alternatively set `OPENAI_API_KEY` in .env)";
const LOGIN_HINT_KR =
  "🔑 **Codex 로그인이 필요합니다.**\n\n" +
  "호스트 PC에서 터미널을 열고 실행하세요:\n```\ncodex login\n```\n" +
  "그 후 다시 시도하세요. (또는 .env에 `OPENAI_API_KEY` 설정)";

export async function detectCodex(): Promise<CodexDetection> {
  if (cached) return cached;

  // Step 1: which
  try {
    const which = await execAsync("which codex");
    if (!which.stdout.trim()) throw new Error("empty");
  } catch {
    cached = { ok: false, errorMessage: L(INSTALL_HINT_EN, INSTALL_HINT_KR) };
    return cached;
  }

  // Step 2: --version
  try {
    const v = await execAsync("codex --version", { timeout: 5000 });
    if (!v.stdout.trim()) throw new Error("empty version");
  } catch {
    cached = { ok: false, errorMessage: L(RUN_FAIL_EN, RUN_FAIL_KR) };
    return cached;
  }

  // Step 3: auth (best-effort — codex auth status may not exist in all versions)
  try {
    const auth = await execAsync("codex auth status", { timeout: 5000 });
    if (
      /not logged in|unauthorized/i.test(auth.stderr ?? "") ||
      /not logged in|unauthorized/i.test(auth.stdout ?? "")
    ) {
      throw new Error("not logged in");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // "command not found" style — auth subcommand missing in this codex version;
    // proceed anyway (M4 will refine this by trying thread/start as auth check).
    if (/unknown command|unrecognized subcommand/i.test(errMsg)) {
      // Silently pass — Open Question #2 tracks this refinement
    } else {
      cached = { ok: false, errorMessage: L(LOGIN_HINT_EN, LOGIN_HINT_KR) };
      return cached;
    }
  }

  cached = { ok: true, errorMessage: "" };
  return cached;
}
