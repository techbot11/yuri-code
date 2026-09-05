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
  for (const entry of text.split("\0")) {
    if (!entry) continue;
    // Strip shell noise BEFORE looking for '=', not after. A banner arrives
    // glued to the first assignment (it has no NUL after it), and a banner
    // containing an '=' -- a "====" divider, which real MOTDs are full of --
    // would put that '=' before the true one if we searched the whole chunk,
    // discarding the real assignment entirely.
    //
    // Only take the after-last-newline slice when it actually looks like an
    // assignment (`NAME=...`); otherwise fall back to the whole chunk. That
    // fallback is what keeps a multi-line VALUE working -- env -0's whole
    // reason for existing -- because then the last newline sits inside the
    // value, the text after it doesn't look like an assignment, and we use
    // the full chunk instead of truncating the value at that newline.
    const nl = entry.lastIndexOf("\n");
    let assignment = entry;
    if (nl !== -1) {
      const candidate = entry.slice(nl + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate)) assignment = candidate;
    }
    const eq = assignment.indexOf("=");
    // A chunk with no '=' is not an assignment. Skipping it beats inventing
    // a key with an empty name.
    if (eq <= 0) continue;
    const name = assignment.slice(0, eq);
    // It must actually be a variable name, so genuine junk is still dropped
    // rather than becoming a key with a plausible-looking value.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    out[name] = assignment.slice(eq + 1);
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
