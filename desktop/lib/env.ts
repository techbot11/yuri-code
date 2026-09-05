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
    // ONE pass, no slicing until a match. Track whether the current line is
    // still a valid variable-name prefix; the first '=' that arrives while it
    // is becomes the assignment.
    //
    // Two things this has to get right at once, and four earlier attempts got
    // one at the expense of the other:
    //   - A shell banner arrives glued to the FIRST chunk (no NUL follows it),
    //     and a banner containing '=' -- a "====" divider, which real MOTDs
    //     are full of -- must not be mistaken for the assignment.
    //   - A VALUE may contain a newline (the whole reason the delimiter is
    //     NUL), and its later lines may themselves look like "NAME=value";
    //     those belong to the value, since NUL is the only record separator.
    //
    // One case is genuinely ambiguous and left as-is on purpose: a banner
    // whose LAST line happens to look like an assignment (e.g. "Setting
    // up\nDEBUG=true (banner text)") is indistinguishable from a real
    // variable. Failing open -- a spurious key -- is the right way round,
    // because failing closed would lose a real variable that has the same
    // shape.
    //
    // It is also O(n). A prior version re-sliced a growing prefix per
    // rejected '=', which took 38 SECONDS on 400k '=' characters -- running
    // synchronously in the main process after the child had exited, so the
    // probe's timeout did not bound it and the UI froze. That is precisely
    // the "never hangs" guarantee this subsystem exists to provide, and a
    // banner saturated with '=' (base64 padding from an iTerm2 inline image,
    // ASCII-art dividers, a prompt theme dumping a blob) is well within what
    // the 4MB maxBuffer ceiling allows through.
    let nameStart = 0;
    let valid = false;
    let name = "";
    let value = "";
    for (let i = 0; i < entry.length; i++) {
      const c = entry.charCodeAt(i);
      if (c === 10) {            // \n -- a new line, so a new name may start
        nameStart = i + 1;
        valid = false;
        continue;
      }
      if (c === 61) {            // =
        if (valid && i > nameStart) {
          name = entry.slice(nameStart, i);
          value = entry.slice(i + 1);
        }
        if (name) break;
        continue;
      }
      const alpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
      const digit = c >= 48 && c <= 57;
      // First character of the line must start a name; later ones may extend
      // it. Once broken, it stays broken until the next newline.
      if (i === nameStart) valid = alpha;
      else if (valid) valid = alpha || digit;
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
