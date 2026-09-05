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
    const eq = entry.indexOf("=");
    // A chunk with no '=' is not an assignment. Skipping it beats inventing
    // a key with an empty name.
    if (eq <= 0) continue;
    // A shell that prints anything before `env -0` -- a motd, an nvm notice,
    // whatever a .zshrc echoes -- has no NUL after its banner, so the banner
    // arrives glued to the FIRST assignment. Taking the name from after the
    // last newline recovers that variable instead of filing it under a key
    // made of the banner. Measured: without this, PATH was lost and every
    // later variable survived.
    const name = entry.slice(0, eq).split("\n").pop() || "";
    // And it must actually be a variable name, so genuine junk is still
    // dropped rather than becoming a key with a plausible-looking value.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    out[name] = entry.slice(eq + 1);
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
  const existing = (env.PATH || "").split(":").filter(Boolean);
  const seen = new Set(existing);
  const extra: string[] = [];
  for (const dir of FALLBACK_PATH_DIRS) {
    const abs = dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : dir;
    if (!seen.has(abs)) {
      seen.add(abs);
      extra.push(abs);
    }
  }
  return { ...env, PATH: [...existing, ...extra].join(":") };
}
