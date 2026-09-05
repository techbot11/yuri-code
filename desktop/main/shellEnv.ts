// The impure half of lib/env.ts: actually asking the user's shell.
//
// Bounded and best-effort by design. A shell that hangs on a slow prompt, or
// prints noise, must not stop the app from starting -- lib/env.ts's fallback
// PATH is there for exactly that.
import { execFile } from "node:child_process";
import * as os from "node:os";
import { parseEnvOutput, type Env } from "../lib/env";

export const PROBE_TIMEOUT_MS = 4000;

/** The user's login environment, or null if we could not get it.
 *
 *  `-l -i` is what makes this work at all: ~/.zshrc is read only by
 *  INTERACTIVE shells, and that is where people export ANTHROPIC_* and put
 *  Homebrew on PATH. `env -0` because a value may contain a newline.
 */
export function probeLoginEnv(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<Env | null> {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(shell, ["-l", "-i", "-c", "env -0"],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        // Never reject: a failed probe is a fact to work around, not an error
        // to propagate. A shell that prints a banner still succeeds, because
        // parseEnvOutput skips anything that is not an assignment.
        //
        // A maxBuffer overflow hands back TRUNCATED stdout alongside the
        // error, so `stdout` being truthy is not proof of success. Accepting
        // a buffer cut mid-value would give a child a corrupted credential
        // (e.g. a truncated ANTHROPIC_AUTH_TOKEN), which fails downstream
        // with an auth error instead of falling back here -- worse than
        // resolving null. Never log err.message or any part of stdout: both
        // can carry a secret value.
        const e = err as (Error & { code?: string }) | null;
        if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve(null);
        if (!stdout) return resolve(null);
        try {
          const parsed = parseEnvOutput(stdout);
          resolve(Object.keys(parsed).length > 0 ? parsed : null);
        } catch {
          resolve(null);
        }
      });
  });
}

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}
