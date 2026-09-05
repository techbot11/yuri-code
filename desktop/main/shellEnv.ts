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
        if (!stdout) return resolve(null);
        try {
          const parsed = parseEnvOutput(stdout);
          resolve(Object.keys(parsed).length > 0 ? parsed : null);
        } catch {
          resolve(null);
        }
        void err;
      });
  });
}

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}
