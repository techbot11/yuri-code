// The environment the children get, and how we work out what it should be.
//
// A macOS .app launched from the Dock inherits launchd's environment, not the
// user's shell: PATH is roughly /usr/bin:/bin:/usr/sbin:/sbin, and anything
// exported from ~/.zshrc is absent because .zshrc is read only by interactive
// shells. So `claude` and `tmux` are invisible, and a custom model or gateway
// configured in the shell never reaches an agent.
//
// Pure so `node --test` reaches it. The impure probe is main/shellEnv.ts.

export type Env = Record<string, string>;

/** Where the tools actually live on macOS, for when the probe fails. Ordered
 *  most-likely-first. `~` is expanded by withFallbackPath. */
export const FALLBACK_PATH_DIRS: string[] = [
  "/opt/homebrew/bin",   // Homebrew, Apple Silicon
  "/usr/local/bin",      // Homebrew on Intel, and hand-installed tools
  "~/.local/bin",        // pipx, uv, and Claude Code's own installer
  "~/.bun/bin",
  "~/.npm-global/bin",
  "~/node_modules/.bin",
];

/** Parse `env -0` output. NUL-delimited rather than newline, because a value
 *  may legitimately contain a newline and a line-based parse would split it
 *  into a garbage key. */
export function parseEnvOutput(text: string): Env {
  const out: Env = {};
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const entry of text.split("\0")) {
    if (!entry) continue;
    // Find the first '=' that is actually an assignment's, by testing the
    // name it would imply. Two things make the naive scans wrong:
    //
    //   - A shell banner arrives glued to the FIRST chunk (it has no NUL
    //     after it), and a banner containing '=' -- a "====" divider, which
    //     real MOTDs are full of -- makes indexOf("=") point into the noise.
    //   - A VALUE may contain a newline (the reason the delimiter is NUL),
    //     and its later lines may themselves look like "NAME=value". Anchoring
    //     on the LAST newline therefore mistakes a continuation line for the
    //     assignment and loses the real variable.
    //
    // Testing the candidate name settles both: the banner's '=' implies a
    // name like "====" and is skipped, while a real "A=x\nB=y" is taken as A
    // with the value "x\nB=y" -- which is what the format means, since NUL is
    // the only record separator.
    //
    // One case is genuinely ambiguous and left as-is on purpose: a banner
    // whose LAST line happens to look like an assignment (e.g. "Setting
    // up\nDEBUG=true (banner text)") is indistinguishable from a real
    // variable. Failing open -- a spurious key -- is the right way round,
    // because failing closed would lose a real variable that has the same
    // shape.
    //
    // The scan condition is `i !== -1`, not `i > 0`: a divider that starts
    // AT index 0 (e.g. a "====" banner beginning the chunk) is a real '='
    // position that must still be tested and rejected, not treated as "none
    // found". Traced against the "====" divider test below: with `i > 0` the
    // loop exits on the very first character instead of scanning past it,
    // and the real PATH= further in the chunk is never reached.
    let name = "";
    let value = "";
    for (let i = entry.indexOf("="); i !== -1; i = entry.indexOf("=", i + 1)) {
      const before = entry.slice(0, i);
      const candidate = before.slice(before.lastIndexOf("\n") + 1);
      if (NAME.test(candidate)) {
        name = candidate;
        value = entry.slice(i + 1);
        break;
      }
    }
    if (name) out[name] = value;
  }
  return out;
}

/** The probed environment layered over what we inherited.
 *
 *  A blank probed value is IGNORED rather than treated as authoritative: a
 *  login shell can print an empty assignment, and blanking a variable the app
 *  needs is worse than keeping a stale one. */
export function mergeEnv(base: Env, probed: Env | null): Env {
  if (!probed) return { ...base };
  const out: Env = { ...base };
  for (const [k, v] of Object.entries(probed)) {
    if (v !== "") out[k] = v;
  }
  return out;
}

/** Append the known install locations to PATH.
 *
 *  Appended, never substituted: whatever the probe or launchd gave us keeps
 *  priority, and this only adds places to look. Duplicates are dropped so a
 *  repeated directory does not make PATH grow on every launch. */
export function withFallbackPath(env: Env, home: string): Env {
  // Normalised for comparison only -- entries we keep stay verbatim. Without
  // this, an inherited "/opt/homebrew/bin/" (trailing slash) would not match
  // the fallback's "/opt/homebrew/bin" and a redundant entry would be added.
  const norm = (d: string) => d.replace(/\/+$/, "") || "/";
  const existing = (env.PATH || "").split(":").filter(Boolean);
  const seen = new Set(existing.map(norm));
  const extra: string[] = [];
  for (const dir of FALLBACK_PATH_DIRS) {
    const abs = dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : dir;
    if (!seen.has(norm(abs))) {
      seen.add(norm(abs));
      extra.push(abs);
    }
  }
  return { ...env, PATH: [...existing, ...extra].join(":") };
}
