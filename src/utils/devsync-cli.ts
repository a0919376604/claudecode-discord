import { spawn } from "node:child_process";

export interface DevsyncResult {
  ok: boolean; // exit code === 0
  code: number; // exit code (-1 on timeout, 127 on ENOENT)
  stdout: string; // ANSI-stripped
  stderr: string; // ANSI-stripped
}

export interface RunDevsyncOptions {
  timeoutMs?: number; // default 30_000
  input?: string; // stdin
}

const ANSI_RE = /\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Spawn the local `devsync` CLI and capture stdout/stderr.
 * The ONLY place that calls child_process.spawn('devsync', ...) per
 * the spec (REQ-009). All Discord-side code goes through this wrapper.
 */
export async function runDevsync(
  args: string[],
  opts: RunDevsyncOptions = {},
): Promise<DevsyncResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<DevsyncResult>((resolve) => {
    const child = spawn("devsync", args, {
      stdio: opts.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: DevsyncResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle({
        ok: false,
        code: -1,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr) + `\ndevsync ${args.join(" ")} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({
          ok: false,
          code: 127,
          stdout: "",
          stderr:
            "devsync CLI not found. Install: uv tool install ~/Desktop/code/devsync",
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

    if (opts.input) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}
