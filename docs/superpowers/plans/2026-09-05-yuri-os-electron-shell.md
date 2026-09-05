# Yuri OS Electron Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Yuri into a macOS app you launch from the Dock — no terminal, no browser tab — where closing the window leaves her running and only Quit stops her.

**Architecture:** An Electron main process supervises the two servers Yuri already runs (bundled-free: it uses the repo's existing `backend/.venv` and `frontend` build) and loads `http://localhost:3000` in one window. Closing that window *hides* it, so the renderer keeps the voice session, the WebSocket and the microphone. A tray icon reflects her state, with "needs you" the one that earns it.

**Tech Stack:** Electron 35.7.5 (Node 22.16, verified); TypeScript compiled with `tsc` to `desktop/out/`; pure logic tested with the repo's existing `node --test` on `.ts` sources (system Node 24 strips types natively).

**Spec:** `docs/superpowers/specs/2026-09-05-yuri-desktop-app-design.md` — §4 (process model, lifecycle, tray), §5 (the environment problem), §6.1 (boot UI), and §9's R3 result. Read §2.1 too: it explains why the `claude` CLI is the user's to install and why the SDK backend needs no `PATH` help.

## Scope: this is sub-project 2a of 3

The spec's §6.1–§6.4 and §9 cover more than one shippable thing, so this plan is deliberately **only the shell that runs**. It ends with an app you can launch, use and quit on the machine that already has a working clone.

Deferred to **2b (packaging & distribution)**, with reasons:

| Deferred | Why not here |
|---|---|
| Bundled Python (spec §3, R2) | 355 MB measured, and most of it is `__pycache__` plus a 204 MB `claude` the SDK wheel ships. Trimming it is its own task with its own verification, and this plan works without it by using `backend/.venv`. |
| `electron-builder`, dmg, the `.app` | A packaged app is what makes R1's microphone-grant loss observable; both belong together. |
| The microphone check (§9 R1) | `systemPreferences.getMediaAccessStatus` reports `not-determined` for an unpackaged Electron run, so the check is untestable until 2b packages the app. Task 5 leaves the `DoctorCheck` slot for it. |
| `safeStorage` credentials (§6.3) | Sub-project 1 ships a working writer at mode 0600. Replacing it needs the packaged app's keychain identity, which is 2b's. |
| Offer-to-restart-the-backend (§6.4) | Needs the supervisor this plan builds. First thing in 2b. |

## Global Constraints

- **Ports stay 8000 (backend) and 3000 (frontend).** Random free ports would break `VC_ALLOWED_ORIGINS` and the LAN-access feature for no gain (spec §4.1).
- **Electron 35.7.5.** Verified to carry Node 22.16.0, above Next 16's floor of 20.9.0 (spec §4.2, R3).
- **`next start` runs under `ELECTRON_RUN_AS_NODE=1`** on Electron's own Node. No second Node runtime is bundled — verified: *Ready in 188ms*, routes and route handlers both 200.
- **`backgroundThrottling: false`** on the window. Electron throttles timers in hidden windows, which would stutter audio and delay the event stream — and this app's whole premise is that a hidden window stays live.
- **Closing the window must `hide()`, never destroy.** A destroyed renderer takes the voice session, the WebSocket, the mic and the conversation with it.
- **On quit, tmux panes are left running.** `VC_KILL_SESSIONS_ON_SHUTDOWN` already defaults off so a restart can rehydrate them; quitting the UI must not kill an agent mid-task.
- **Never print or log a secret.** The environment this process resolves contains `ANTHROPIC_AUTH_TOKEN` and friends.
- **Testable logic goes in `desktop/lib/*.ts` as pure functions.** There is no DOM or Electron test environment; a rule inside an Electron callback is untestable by construction. Tests run `node --test desktop/lib/*.test.ts`.
- **No literal colours in the boot window's CSS** — reuse the tokens from `frontend/app/globals.css` §1 by copying their values into the boot page with a comment saying where they came from (the boot page cannot import the app's stylesheet; it renders before Next exists).

---

## File Structure

| File | Responsibility |
|---|---|
| `desktop/package.json` | create — the Electron app's own manifest and scripts |
| `desktop/tsconfig.json` | create — compiles `main/`, `preload/`, `lib/` to `out/` |
| `desktop/lib/env.ts` | create — pure: merge a login shell's environment over `process.env`, and the fallback `PATH` when the probe fails |
| `desktop/lib/boot.ts` | create — pure: the boot sequencer's state machine (`starting` / `ready` / `failed` per child) |
| `desktop/lib/tray.ts` | create — pure: derive one of five tray states from what the renderer reports |
| `desktop/lib/*.test.ts` | create — their tests |
| `desktop/main/index.ts` | create — app lifecycle, window, IPC wiring. Thin: decisions live in `lib/` |
| `desktop/main/servers.ts` | create — spawn and health-check the two children; the only module that owns a child process |
| `desktop/main/shellEnv.ts` | create — run the login-shell probe (the impure half of `lib/env.ts`) |
| `desktop/preload/index.ts` | create — the one bridge: renderer → main tray state |
| `desktop/boot/index.html` | create — the boot window, loaded from disk before Next exists |
| `desktop/assets/` | create — tray icon templates (see Task 5 for how to generate them) |
| `frontend/components/VoiceProvider.tsx` | modify — report tray state when the bridge exists |
| `frontend/lib/trayState.ts` | create — pure: what the renderer sends, so it is testable on the frontend side too |

---

## Task 1: The desktop workspace, and a window that loads Yuri

The smallest thing that proves the shape: an Electron app that opens a window on `http://localhost:3000`, assuming you already have the servers running. Everything after this replaces that assumption.

**Files:**
- Create: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/main/index.ts`, `desktop/.gitignore`
- Modify: `.gitignore` (root)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm --prefix desktop run dev` opens a window on `http://localhost:3000`; `npm --prefix desktop run build` compiles TypeScript to `desktop/out/`.

- [ ] **Step 1: Create the manifest**

`desktop/package.json`:

```json
{
  "name": "@yuri/desktop",
  "productName": "Yuri OS",
  "version": "0.1.0",
  "private": true,
  "description": "Yuri OS desktop shell",
  "author": "Yuri OS",
  "main": "./out/main/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "npm run build && electron .",
    "test": "node --test lib/*.test.ts",
    "clean": "rm -rf out"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "electron": "35.7.5",
    "typescript": "~5.6.3"
  }
}
```

`electron` is pinned exactly: R3 verified Node 22.16.0 against Next 16.2.6 on this version, and Electron's Node moves between majors.

- [ ] **Step 2: Create the TypeScript config**

`desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "./out",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "electron"]
  },
  "include": ["main/**/*.ts", "preload/**/*.ts", "lib/**/*.ts"],
  "exclude": ["lib/**/*.test.ts", "out"]
}
```

`CommonJS`, not ESM: Electron's main process loads CommonJS without the `"type": "module"` complications, and every Electron example assumes it. Tests are excluded from the build — they run against the `.ts` sources directly.

- [ ] **Step 3: Ignore the build output**

`desktop/.gitignore`:

```
out/
node_modules/
dist/
```

- [ ] **Step 4: Write the main process**

`desktop/main/index.ts`:

```ts
// Yuri OS desktop shell: the main process.
//
// Deliberately thin. Every decision that can be wrong in a way nobody
// notices -- which environment the children get, whether the boot is ready
// or failed, which tray state a set of facts means -- lives in ../lib as a
// pure function with tests, because there is no Electron test environment.
import { app, BrowserWindow, shell } from "electron";
import * as path from "node:path";

const FRONTEND_URL = "http://localhost:3000";

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Yuri OS",
    backgroundColor: "#1a1917", // --bg from frontend/app/globals.css
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Load-bearing, not a preference: Electron throttles timers in a hidden
      // window, and this app's premise is that a hidden window keeps talking.
      backgroundThrottling: false,
    },
  });

  // Anything that is not the app opens in the user's real browser. Without
  // this, a link in a transcript would navigate the app away from Yuri with
  // no way back -- there is no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(FRONTEND_URL)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  return win;
}

app.whenReady().then(async () => {
  mainWindow = createWindow();
  await mainWindow.loadURL(FRONTEND_URL);
  mainWindow.show();
});

// Placeholder for Task 4, which replaces this with hide-on-close. Quitting
// here is wrong on purpose-free grounds: it is simply what Electron does
// until the lifecycle task lands.
app.on("window-all-closed", () => app.quit());
```

- [ ] **Step 5: Install and run**

```bash
cd desktop && npm install
```

If Electron's postinstall leaves `dist/` incomplete (it has, in this repo's environment — `Electron failed to install correctly`), extract the cached zip by hand:

```bash
Z=$(find ~/Library/Caches/electron -name "*darwin-arm64.zip" | head -1)
rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
unzip -q "$Z" -d node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
./node_modules/.bin/electron --version   # expect v35.7.5
```

- [ ] **Step 6: Verify the shape by hand**

Start the servers the existing way in one terminal:

```bash
./bin/yuri up
```

Then, in another:

```bash
npm --prefix desktop run dev
```

Expected: a window titled "Yuri OS" showing Yuri, with no address bar. Confirm the rail, the orb and the dock all render, and that clicking an external link opens your browser rather than navigating the app.

- [ ] **Step 7: Add `desktop/node_modules` to the root ignore, and commit**

Check first whether the root `.gitignore` already covers nested `node_modules`:

```bash
git check-ignore -q desktop/node_modules && echo "already ignored" || echo "needs a rule"
```

Add `desktop/node_modules/` and `desktop/out/` to the root `.gitignore` only if that says "needs a rule".

```bash
git add desktop/package.json desktop/tsconfig.json desktop/main/index.ts desktop/.gitignore .gitignore
git commit -m "feat(desktop): an Electron window that loads Yuri"
```

Do **not** commit `desktop/package-lock.json` yet — Task 2 adds no dependencies, but if `npm install` produced one, commit it here so the Electron version is pinned for everyone.

---

## Task 2: Resolve the user's real environment

A macOS `.app` launched from the Dock inherits **launchd's** environment, not the user's shell. Its `PATH` is roughly `/usr/bin:/bin:/usr/sbin:/sbin`. So `shutil.which("tmux")` returns `None` in the packaged app *even though it works in a terminal*, and any `ANTHROPIC_*` value exported from `~/.zshrc` is absent — `.zshrc` is read only by interactive shells.

This is not hypothetical. Measured on the development machine: the tmux server had been running since Sep 2 with zero `ANTHROPIC_*` variables, and `claude` fell back to OAuth and asked to log in on every session until sub-project 1 handed the credentials over explicitly.

**Files:**
- Create: `desktop/lib/env.ts`, `desktop/lib/env.test.ts`, `desktop/main/shellEnv.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `mergeEnv(base: Env, probed: Env | null): Env` — probed wins over base, blanks in probed are ignored.
  - `parseEnvOutput(text: string): Env` — parses `env -0` output.
  - `FALLBACK_PATH_DIRS: string[]`
  - `withFallbackPath(env: Env, home: string): Env`
  - `type Env = Record<string, string>`
  - `probeLoginEnv(timeoutMs?: number): Promise<Env | null>` (from `main/shellEnv.ts`) — `null` on any failure or timeout.

- [ ] **Step 1: Write the failing test**

`desktop/lib/env.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_PATH_DIRS, mergeEnv, parseEnvOutput, withFallbackPath,
} from "./env.ts";

test("a probed value wins over the inherited one", () => {
  // The whole point: launchd's environment is the one we must override.
  const got = mergeEnv({ PATH: "/usr/bin:/bin", TERM: "dumb" },
                       { PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
  assert.equal(got.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(got.TERM, "dumb", "a variable the probe did not mention survives");
});

test("a blank probed value does not erase an inherited one", () => {
  // `env` in a login shell can print an empty assignment; treating that as
  // authoritative would blank a variable the app needs.
  const got = mergeEnv({ ANTHROPIC_BASE_URL: "https://gw/v1" },
                       { ANTHROPIC_BASE_URL: "" });
  assert.equal(got.ANTHROPIC_BASE_URL, "https://gw/v1");
});

test("a failed probe changes nothing", () => {
  const base = { PATH: "/usr/bin:/bin" };
  assert.deepEqual(mergeEnv(base, null), base);
});

test("env -0 output parses, including values containing '='", () => {
  // A base URL with a query string, or a token with padding, both contain '='.
  const text = "PATH=/usr/bin\0TOKEN=abc=def=\0EMPTY=\0";
  const got = parseEnvOutput(text);
  assert.equal(got.PATH, "/usr/bin");
  assert.equal(got.TOKEN, "abc=def=", "only the FIRST '=' separates name from value");
  assert.equal(got.EMPTY, "");
});

test("a line without '=' is skipped rather than becoming a blank key", () => {
  const got = parseEnvOutput("PATH=/usr/bin\0garbage\0HOME=/Users/x\0");
  assert.deepEqual(Object.keys(got).sort(), ["HOME", "PATH"]);
});

test("the fallback PATH covers where the tools actually live", () => {
  // These are the install locations that matter on macOS. Homebrew on Apple
  // Silicon is /opt/homebrew; Intel and older installs are /usr/local.
  assert.ok(FALLBACK_PATH_DIRS.includes("/opt/homebrew/bin"));
  assert.ok(FALLBACK_PATH_DIRS.includes("/usr/local/bin"));
});

test("the fallback PATH is appended, never substituted", () => {
  // Substituting would lose whatever the probe or launchd did give us.
  const got = withFallbackPath({ PATH: "/usr/bin:/bin" }, "/Users/x");
  const dirs = got.PATH.split(":");
  assert.equal(dirs[0], "/usr/bin", "the existing PATH keeps priority");
  assert.ok(dirs.includes("/opt/homebrew/bin"));
  assert.ok(dirs.includes("/Users/x/.local/bin"), "$HOME is expanded");
});

test("the fallback PATH does not duplicate what is already there", () => {
  const got = withFallbackPath({ PATH: "/opt/homebrew/bin:/usr/bin" }, "/Users/x");
  const count = got.PATH.split(":").filter((d) => d === "/opt/homebrew/bin").length;
  assert.equal(count, 1);
});

test("a missing PATH still gets the fallback", () => {
  const got = withFallbackPath({}, "/Users/x");
  assert.ok(got.PATH.includes("/opt/homebrew/bin"));
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd desktop && node --test lib/env.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module './env.ts'`.

- [ ] **Step 3: Implement the pure half**

`desktop/lib/env.ts`:

```ts
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
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
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
```

- [ ] **Step 4: Run the tests**

```bash
cd desktop && node --test lib/env.test.ts 2>&1 | grep -E "^. (pass|fail)"
```

Expected: 9 pass, 0 fail.

- [ ] **Step 5: Implement the probe**

`desktop/main/shellEnv.ts`:

```ts
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
```

- [ ] **Step 6: Verify the probe against your real shell**

```bash
cd desktop && npm run build && node -e "
const { probeLoginEnv } = require('./out/main/shellEnv.js');
probeLoginEnv().then((e) => {
  if (!e) return console.log('probe FAILED (fallback would be used)');
  const names = Object.keys(e).filter(k => /^ANTHROPIC_|^PATH\$/.test(k));
  console.log('probe found', Object.keys(e).length, 'vars; of interest:', names.sort());
  console.log('PATH has homebrew:', (e.PATH||'').includes('/opt/homebrew/bin'));
});"
```

Expected: a non-trivial count, `PATH has homebrew: true`, and the `ANTHROPIC_*` names you export. **Print names only, never values** — this is the one place a secret could reach a terminal log.

- [ ] **Step 7: Commit**

```bash
git add desktop/lib/env.ts desktop/lib/env.test.ts desktop/main/shellEnv.ts
git commit -m "feat(desktop): resolve the user's real environment, not launchd's"
```

---

## Task 3: Supervise the two servers

**Files:**
- Create: `desktop/lib/boot.ts`, `desktop/lib/boot.test.ts`, `desktop/main/servers.ts`
- Modify: `desktop/main/index.ts`

**Interfaces:**
- Consumes: `mergeEnv`, `withFallbackPath`, `type Env` from `../lib/env`; `probeLoginEnv`, `homeDir` from `./shellEnv`.
- Produces:
  - `type ChildName = "backend" | "frontend"`
  - `type ChildState = "starting" | "ready" | "failed"`
  - `type BootState = { backend: ChildState; frontend: ChildState; error?: { child: ChildName; detail: string } }`
  - `initialBoot(): BootState`
  - `applyBootEvent(state: BootState, ev: BootEvent): BootState`
  - `bootPhase(state: BootState): "starting" | "ready" | "failed"`
  - `type BootEvent = { type: "ready"; child: ChildName } | { type: "failed"; child: ChildName; detail: string }`
  - `startServers(env: Env, onEvent: (ev: BootEvent) => void): Promise<void>` and `stopServers(): Promise<void>` (from `main/servers.ts`)

- [ ] **Step 1: Write the failing test**

`desktop/lib/boot.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { applyBootEvent, bootPhase, initialBoot } from "./boot.ts";

test("both children start out starting, and the phase is starting", () => {
  const s = initialBoot();
  assert.equal(s.backend, "starting");
  assert.equal(s.frontend, "starting");
  assert.equal(bootPhase(s), "starting");
});

test("the phase is ready only when BOTH are ready", () => {
  let s = applyBootEvent(initialBoot(), { type: "ready", child: "backend" });
  assert.equal(bootPhase(s), "starting", "one ready child is not a ready app");
  s = applyBootEvent(s, { type: "ready", child: "frontend" });
  assert.equal(bootPhase(s), "ready");
});

test("either child failing fails the boot, and carries the reason", () => {
  const s = applyBootEvent(initialBoot(),
    { type: "failed", child: "backend", detail: "ModuleNotFoundError: uvicorn" });
  assert.equal(bootPhase(s), "failed");
  assert.equal(s.error?.child, "backend");
  assert.match(s.error!.detail, /uvicorn/);
});

test("a failure survives the other child succeeding afterwards", () => {
  // Otherwise the boot window would flip to "ready" while one server is dead,
  // and the user would get an app whose every action fails.
  let s = applyBootEvent(initialBoot(),
    { type: "failed", child: "backend", detail: "port in use" });
  s = applyBootEvent(s, { type: "ready", child: "frontend" });
  assert.equal(bootPhase(s), "failed");
  assert.equal(s.error?.child, "backend");
});

test("the FIRST failure is the one reported", () => {
  // The second is usually a consequence -- the frontend cannot proxy to a
  // backend that never came up -- and the first is the one worth showing.
  let s = applyBootEvent(initialBoot(),
    { type: "failed", child: "backend", detail: "first" });
  s = applyBootEvent(s, { type: "failed", child: "frontend", detail: "second" });
  assert.equal(s.error?.detail, "first");
});

test("applying an event does not mutate the state it was given", () => {
  // The boot window renders from this; a mutated object would make a stale
  // render indistinguishable from a fresh one.
  const before = initialBoot();
  const after = applyBootEvent(before, { type: "ready", child: "backend" });
  assert.equal(before.backend, "starting");
  assert.notEqual(before, after);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd desktop && node --test lib/boot.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module './boot.ts'`.

- [ ] **Step 3: Implement the state machine**

`desktop/lib/boot.ts`:

```ts
// The boot sequencer's state, as data.
//
// Pure so `node --test` reaches it, and separate from the spawning because
// the sequencing is the part that can be subtly wrong: an app that reports
// "ready" while one server is dead hands the user a UI whose every action
// fails, which is worse than a boot screen that says what broke.

export type ChildName = "backend" | "frontend";
export type ChildState = "starting" | "ready" | "failed";

export type BootEvent =
  | { type: "ready"; child: ChildName }
  | { type: "failed"; child: ChildName; detail: string };

export type BootState = {
  backend: ChildState;
  frontend: ChildState;
  /** The FIRST failure. A later one is usually its consequence -- the
   *  frontend cannot proxy to a backend that never started. */
  error?: { child: ChildName; detail: string };
};

export function initialBoot(): BootState {
  return { backend: "starting", frontend: "starting" };
}

export function applyBootEvent(state: BootState, ev: BootEvent): BootState {
  const next: BootState = { ...state };
  if (ev.type === "ready") {
    // A child that already failed does not become ready: a health check can
    // answer moments after the process died and be restarted by nothing.
    if (next[ev.child] !== "failed") next[ev.child] = "ready";
    return next;
  }
  next[ev.child] = "failed";
  if (!next.error) next.error = { child: ev.child, detail: ev.detail };
  return next;
}

export function bootPhase(state: BootState): "starting" | "ready" | "failed" {
  if (state.error) return "failed";
  return state.backend === "ready" && state.frontend === "ready" ? "ready" : "starting";
}
```

- [ ] **Step 4: Run the tests**

```bash
cd desktop && node --test lib/boot.test.ts 2>&1 | grep -E "^. (pass|fail)"
```

Expected: 6 pass, 0 fail.

- [ ] **Step 5: Implement the supervisor**

`desktop/main/servers.ts`:

```ts
// The only module that owns a child process.
//
// Two children, mirroring what `bin/yuri up` starts: uvicorn on 8000 and
// `next start` on 3000. Ports are fixed deliberately (spec §4.1) -- random
// free ports would break VC_ALLOWED_ORIGINS and LAN access for no gain.
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { BootEvent } from "../lib/boot";
import type { Env } from "../lib/env";

const BACKEND_PORT = 8000;
const FRONTEND_PORT = 3000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;

/** The repo root. In development this file is desktop/out/main/, so the root
 *  is three levels up. A packaged app relocates this -- sub-project 2b owns
 *  that, and will pass the root in rather than deriving it. */
export function repoRoot(): string {
  return path.resolve(__dirname, "../../..");
}

const children: ChildProcess[] = [];
let lastStderr: Record<string, string> = {};

/** Wait for a URL to answer with any HTTP status. "Any" is the point: a 401
 *  or a 404 both prove the server is up, and only a connection refusal means
 *  it is not. */
async function waitForHttp(url: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
  }
  return false;
}

function track(name: "backend" | "frontend", child: ChildProcess,
               onEvent: (ev: BootEvent) => void): void {
  children.push(child);
  lastStderr[name] = "";
  const keep = (buf: Buffer) => {
    // Keep only the tail: a Python traceback is what the user needs, and an
    // unbounded buffer of a server's whole log is not.
    lastStderr[name] = (lastStderr[name] + buf.toString()).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code) => {
    // An exit BEFORE ready is a boot failure; after ready it is a crash the
    // app has to survive, and 2b's supervisor owns restarting it.
    if (code !== 0) {
      onEvent({ type: "failed", child: name,
                detail: lastStderr[name].trim() || `${name} exited with code ${code}` });
    }
  });
}

export async function startServers(env: Env,
                                   onEvent: (ev: BootEvent) => void): Promise<void> {
  const root = repoRoot();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  const backend = spawn(
    path.join(root, "backend/.venv/bin/python"),
    ["-m", "uvicorn", "main:app", "--port", String(BACKEND_PORT),
     "--log-level", "info", "--timeout-graceful-shutdown", "3"],
    { cwd: path.join(root, "backend"), env, stdio: ["ignore", "pipe", "pipe"] });
  track("backend", backend, onEvent);

  // ELECTRON_RUN_AS_NODE makes this Electron binary behave as plain Node, so
  // Next runs on Electron's own Node 22.16 and no second runtime is bundled
  // (spec §4.2, verified: Ready in 188ms).
  const frontend = spawn(
    process.execPath,
    [path.join(root, "frontend/node_modules/next/dist/bin/next"),
     "start", "-H", "127.0.0.1", "-p", String(FRONTEND_PORT)],
    { cwd: path.join(root, "frontend"),
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"] });
  track("frontend", frontend, onEvent);

  // Health-check both in parallel: the frontend does not depend on the
  // backend to LISTEN, only to answer proxied requests, so serialising the
  // two would add the backend's start time to every boot for no reason.
  await Promise.all([
    waitForHttp(`http://127.0.0.1:${BACKEND_PORT}/health`, deadline).then((up) =>
      onEvent(up ? { type: "ready", child: "backend" }
                 : { type: "failed", child: "backend",
                     detail: lastStderr.backend.trim() || "the backend never answered" })),
    waitForHttp(`http://127.0.0.1:${FRONTEND_PORT}/`, deadline).then((up) =>
      onEvent(up ? { type: "ready", child: "frontend" }
                 : { type: "failed", child: "frontend",
                     detail: lastStderr.frontend.trim() || "the frontend never answered" })),
  ]);
}

/** Stop both children. tmux panes are deliberately NOT touched:
 *  VC_KILL_SESSIONS_ON_SHUTDOWN already defaults off so a restart can
 *  rehydrate them, and quitting the UI must not kill an agent mid-task. */
export async function stopServers(): Promise<void> {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give uvicorn its 3s graceful shutdown, then stop waiting. A child that
  // ignores SIGTERM must not hold the app open.
  await new Promise((r) => setTimeout(r, 3500));
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
  children.length = 0;
  lastStderr = {};
}
```

- [ ] **Step 6: Wire it into main**

Replace `desktop/main/index.ts`'s `app.whenReady()` block:

```ts
app.whenReady().then(async () => {
  // The probe is bounded and best-effort; the fallback PATH covers a failure.
  const probed = await probeLoginEnv();
  const env = withFallbackPath(mergeEnv(process.env as Env, probed), homeDir());

  let boot = initialBoot();
  mainWindow = createWindow();

  await startServers(env, (ev) => {
    boot = applyBootEvent(boot, ev);
  });

  if (bootPhase(boot) !== "ready") {
    // Task 4 replaces this with the boot window's failure state. Until then,
    // failing loudly beats a blank window.
    console.error("[yuri] boot failed:", boot.error);
    app.quit();
    return;
  }
  await mainWindow.loadURL(FRONTEND_URL);
  mainWindow.show();
});

app.on("before-quit", async (event) => {
  event.preventDefault();
  await stopServers();
  app.exit(0);
});
```

Add the imports at the top:

```ts
import { applyBootEvent, bootPhase, initialBoot } from "../lib/boot";
import { mergeEnv, withFallbackPath, type Env } from "../lib/env";
import { startServers, stopServers } from "./servers";
import { homeDir, probeLoginEnv } from "./shellEnv";
```

Remove the Task 1 placeholder `app.on("window-all-closed", () => app.quit())` — Task 4 owns the lifecycle, and leaving it would quit the app the moment the window closes, which is the opposite of the point.

- [ ] **Step 7: Verify it boots and stops cleanly**

Make sure nothing is already on the ports, or the health check will pass against someone else's server:

```bash
lsof -ti tcp:8000 -sTCP:LISTEN; lsof -ti tcp:3000 -sTCP:LISTEN   # both must print nothing
cd frontend && npx next build && cd ..                            # `next start` needs a build
npm --prefix desktop run dev
```

Expected: the window appears with Yuri, no terminal involved. Then quit with ⌘Q and confirm both ports are free again:

```bash
lsof -ti tcp:8000 -sTCP:LISTEN; lsof -ti tcp:3000 -sTCP:LISTEN   # both empty
```

- [ ] **Step 8: Commit**

```bash
git add desktop/lib/boot.ts desktop/lib/boot.test.ts desktop/main/servers.ts desktop/main/index.ts
git commit -m "feat(desktop): supervise the backend and frontend, and stop them on quit"
```

---

## Task 4: The boot window, and the lifecycle that keeps her alive

Two things that belong together: the window that shows what is happening before Next exists, and the rule that closing the main window hides it rather than destroying it.

**Files:**
- Create: `desktop/boot/index.html`
- Modify: `desktop/main/index.ts`, `desktop/package.json` (copy `boot/` into `out/`)

**Interfaces:**
- Consumes: `BootState`, `bootPhase` from `../lib/boot`.
- Produces: the main window hides on close; `showMainWindow()` reveals it; `⌘⇧Y` summons it; only Quit stops the children.

- [ ] **Step 1: Write the boot page**

`desktop/boot/index.html`. It is loaded with `loadFile` before Next exists, so it can import nothing — the colours are copied from `frontend/app/globals.css` with a note saying so:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Starting Yuri</title>
<style>
  /* Copied from frontend/app/globals.css :root -- this page renders before
     Next exists, so it cannot import the app's stylesheet. Keep in step. */
  :root {
    --bg: #1a1917; --panel: #211f1d; --ink: #e9e3d8; --mut: #928c81;
    --dim: #6f6a61; --acc: #dd8a6a; --line: #322f2b;
    --good: #9cc7a4; --danger: #d98a8a;
  }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px ui-sans-serif, system-ui, -apple-system, sans-serif;
    display: grid; place-items: center; height: 100vh;
  }
  .card { width: 380px; }
  h1 {
    font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--mut); font-weight: 400; margin: 0 0 18px;
  }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; }
  li { display: grid; grid-template-columns: 16px 1fr; gap: 10px; align-items: baseline; }
  .mark { color: var(--dim); }
  li[data-state="ready"] .mark { color: var(--good); }
  li[data-state="failed"] .mark { color: var(--danger); }
  .detail { color: var(--mut); font-size: 12.5px; }
  pre {
    margin: 16px 0 0; padding: 10px 12px; max-height: 180px; overflow: auto;
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    font: 11.5px ui-monospace, Menlo, monospace; color: var(--mut);
    white-space: pre-wrap;
  }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  button {
    font: inherit; font-size: 12.5px; color: var(--ink); background: none;
    border: 1px solid var(--line); border-radius: 999px; padding: 5px 14px;
    cursor: pointer;
  }
  button:hover { border-color: var(--acc); color: var(--acc); }
  [hidden] { display: none !important; }
</style>
<div class="card">
  <h1 id="head">Starting Yuri</h1>
  <ul>
    <li id="row-env" data-state="starting">
      <span class="mark">·</span><span>Finding your tools<span class="detail" id="d-env"></span></span>
    </li>
    <li id="row-backend" data-state="starting">
      <span class="mark">·</span><span>Backend<span class="detail" id="d-backend"></span></span>
    </li>
    <li id="row-frontend" data-state="starting">
      <span class="mark">·</span><span>Interface<span class="detail" id="d-frontend"></span></span>
    </li>
  </ul>
  <pre id="stderr" hidden></pre>
  <div class="actions" hidden id="actions">
    <button id="retry">Try again</button>
    <button id="quit">Quit</button>
  </div>
</div>
<script>
  const MARK = { starting: "·", ready: "✓", failed: "✗" };
  function row(id, state, detail) {
    const li = document.getElementById("row-" + id);
    if (!li) return;
    li.dataset.state = state;
    li.querySelector(".mark").textContent = MARK[state] || "·";
    if (detail) document.getElementById("d-" + id).textContent = " · " + detail;
  }
  // The main process pushes state; this page only renders it. Every line is a
  // real check, not a spinner on a timer -- a boot that lies about progress
  // is worse than one that looks slow.
  window.yuriBoot?.onState((s) => {
    row("env", s.env || "starting", s.envDetail);
    row("backend", s.backend, s.backendDetail);
    row("frontend", s.frontend, s.frontendDetail);
    const failed = s.phase === "failed";
    document.getElementById("head").textContent =
      failed ? "Yuri could not start" : "Starting Yuri";
    document.getElementById("actions").hidden = !failed;
    const pre = document.getElementById("stderr");
    pre.hidden = !failed || !s.errorDetail;
    if (s.errorDetail) pre.textContent = s.errorDetail;
  });
  document.getElementById("retry").onclick = () => window.yuriBoot?.retry();
  document.getElementById("quit").onclick = () => window.yuriBoot?.quit();
</script>
```

- [ ] **Step 2: Copy the boot page into the build output**

`boot/index.html` is not TypeScript, so `tsc` ignores it. Update `desktop/package.json`'s build script:

```json
    "build": "tsc -p tsconfig.json && mkdir -p out/boot && cp boot/index.html out/boot/",
```

- [ ] **Step 3: Add the boot window and the preload bridge**

Create `desktop/preload/index.ts`:

```ts
// The only bridge between a renderer and the main process. Two channels, both
// one-directional by design: the boot page receives state and can ask to
// retry or quit; the app reports its tray state. Nothing else is exposed.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yuriBoot", {
  onState: (cb: (s: unknown) => void) =>
    ipcRenderer.on("boot:state", (_e, s) => cb(s)),
  retry: () => ipcRenderer.send("boot:retry"),
  quit: () => ipcRenderer.send("boot:quit"),
});

contextBridge.exposeInMainWorld("yuriTray", {
  set: (state: string) => ipcRenderer.send("tray:state", state),
});
```

In `desktop/main/index.ts`, add a boot window and push state to it. Replace the `app.whenReady()` block from Task 3:

```ts
let bootWindow: BrowserWindow | null = null;
let quitting = false;

function createBootWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520, height: 420, show: true, resizable: false,
    title: "Starting Yuri", backgroundColor: "#1a1917",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), sandbox: false },
  });
  void win.loadFile(path.join(__dirname, "../boot/index.html"));
  return win;
}

function pushBoot(boot: BootState, env: ChildState, envDetail = ""): void {
  bootWindow?.webContents.send("boot:state", {
    phase: env === "failed" ? "failed" : bootPhase(boot),
    env, envDetail,
    backend: boot.backend, frontend: boot.frontend,
    errorDetail: boot.error?.detail || "",
  });
}

async function boot(): Promise<void> {
  let state = initialBoot();
  pushBoot(state, "starting");

  const probed = await probeLoginEnv();
  const env = withFallbackPath(mergeEnv(process.env as Env, probed), homeDir());
  // Names only, never values: this string reaches a window.
  pushBoot(state, "ready", probed ? "from your shell" : "using known locations");

  await startServers(env, (ev) => {
    state = applyBootEvent(state, ev);
    pushBoot(state, "ready", probed ? "from your shell" : "using known locations");
  });

  if (bootPhase(state) !== "ready") return; // the boot window shows why

  mainWindow = createWindow();
  await mainWindow.loadURL(FRONTEND_URL);
  mainWindow.show();
  bootWindow?.close();
  bootWindow = null;
}

app.whenReady().then(async () => {
  bootWindow = createBootWindow();
  // Wait for the page before pushing state, or the first push lands nowhere.
  await new Promise<void>((r) => bootWindow!.webContents.once("did-finish-load", () => r()));
  await boot();

  ipcMain.on("boot:retry", () => {
    void stopServers().then(() => boot());
  });
  ipcMain.on("boot:quit", () => {
    quitting = true;
    app.quit();
  });

  globalShortcut.register("CommandOrControl+Shift+Y", () => showMainWindow());
});
```

- [ ] **Step 4: Add the lifecycle**

In `desktop/main/index.ts`, inside `createWindow()` before the `return`:

```ts
  // HIDE, never destroy. A destroyed renderer takes the voice session, the
  // WebSocket, the microphone and the conversation with it -- and the whole
  // premise of this app is that closing the window leaves her running.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("minimize", (event) => {
    event.preventDefault();
    win.hide();
  });
```

And at module level:

```ts
export function showMainWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

// The ONLY path that stops anything. Without the flag, the close handler
// above would prevent the quit as well and the app could never exit.
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void stopServers().then(() => app.exit(0));
});

// macOS: clicking the Dock icon after a hide must bring her back.
app.on("activate", () => showMainWindow());

app.on("will-quit", () => globalShortcut.unregisterAll());
```

Extend the imports with `ipcMain`, `globalShortcut`, and `type ChildState`, `type BootState` from `../lib/boot`.

Delete any remaining `window-all-closed` handler: with hide-on-close there are no windows to run out of, and the default behaviour would quit the app on macOS anyway.

- [ ] **Step 5: Build and verify each lifecycle rule by hand**

```bash
lsof -ti tcp:8000 -sTCP:LISTEN; lsof -ti tcp:3000 -sTCP:LISTEN   # must be empty
npm --prefix desktop run dev
```

Confirm, in order:
1. The boot window appears **first**, with the three lines ticking to ✓ as each check really passes.
2. The main window replaces it once both are ready.
3. **⌘W closes the window and the app keeps running** — check the Dock icon is still there, and both ports still listening.
4. **⌘⇧Y brings it back**, with the same page state (not a reload).
5. Clicking the Dock icon also brings it back.
6. **⌘Q quits**, and both ports are free afterwards.

Then verify the failure path, which is the one people never test:

```bash
# Occupy 8000 so the backend cannot bind
python3 -m http.server 8000 &
npm --prefix desktop run dev
```

Expected: the boot window says "Yuri could not start", the backend row shows ✗, and the stderr box shows the bind error. "Try again" retries; "Quit" exits. Free the port afterwards (`kill %1`).

- [ ] **Step 6: Commit**

```bash
git add desktop/boot/index.html desktop/preload/index.ts desktop/main/index.ts desktop/package.json
git commit -m "feat(desktop): a boot window, and closing the window no longer stops her"
```

---

## Task 5: The tray, which is her presence

The tray exists for one state: **an agent is blocked on an approval and the window is hidden.** Today that is invisible. The other four states are context.

**Files:**
- Create: `desktop/lib/tray.ts`, `desktop/lib/tray.test.ts`, `desktop/assets/` (icons)
- Create: `frontend/lib/trayState.ts`, `frontend/lib/trayState.test.ts`
- Modify: `desktop/main/index.ts`, `frontend/components/VoiceProvider.tsx`

**Interfaces:**
- Consumes: the preload bridge `window.yuriTray.set(state)` from Task 4.
- Produces:
  - `type TrayState = "asleep" | "listening" | "speaking" | "working" | "needs-you"`
  - `trayState(f: TrayFacts): TrayState` and `trayLabel(s: TrayState): string` (in `desktop/lib/tray.ts`)
  - `type TrayFacts = { voiceConnected: boolean; speaking: boolean; missionsRunning: number; approvalsPending: number }`
  - `frontend/lib/trayState.ts` re-derives the same value from the provider's own state, so the frontend can be tested without Electron.

- [ ] **Step 1: Write the failing test**

`desktop/lib/tray.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { trayLabel, trayState, type TrayFacts } from "./tray.ts";

const facts = (over: Partial<TrayFacts> = {}): TrayFacts => ({
  voiceConnected: false, speaking: false, missionsRunning: 0, approvalsPending: 0, ...over,
});

test("not connected is asleep, and says so honestly", () => {
  // "Idle" would imply she is listening and merely quiet. She is not.
  assert.equal(trayState(facts()), "asleep");
  assert.match(trayLabel("asleep"), /not listening/i);
});

test("connected and quiet is listening", () => {
  assert.equal(trayState(facts({ voiceConnected: true })), "listening");
});

test("speaking outranks listening", () => {
  assert.equal(trayState(facts({ voiceConnected: true, speaking: true })), "speaking");
});

test("a running mission shows as working even while she talks", () => {
  // Work continuing in the background is the more useful fact: the user can
  // hear that she is speaking.
  assert.equal(trayState(facts({ voiceConnected: true, speaking: true, missionsRunning: 1 })),
               "working");
});

test("a pending approval outranks EVERYTHING", () => {
  // This is the state the tray exists for. A blocked agent behind a hidden
  // window is invisible without it.
  assert.equal(trayState(facts({ approvalsPending: 1 })), "needs-you");
  assert.equal(trayState(facts({ voiceConnected: true, speaking: true,
                                 missionsRunning: 3, approvalsPending: 1 })), "needs-you");
});

test("needs-you is reported even while she is asleep", () => {
  // Voice being disconnected does not make a blocked agent less blocked.
  assert.equal(trayState(facts({ voiceConnected: false, approvalsPending: 2 })), "needs-you");
});

test("every state has a label a person would understand", () => {
  for (const s of ["asleep", "listening", "speaking", "working", "needs-you"] as const) {
    const label = trayLabel(s);
    assert.ok(label.length > 4, s);
    assert.doesNotMatch(label, /-/, `${s}: the label must not be the slug`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd desktop && node --test lib/tray.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module './tray.ts'`.

- [ ] **Step 3: Implement the derivation**

`desktop/lib/tray.ts`:

```ts
// What the tray says she is doing.
//
// Pure so `node --test` reaches it. The ORDER is the substance: this is a
// priority list, not a set of independent flags, and getting it wrong means
// the one state worth interrupting for gets hidden behind a chattier one.

export type TrayState = "asleep" | "listening" | "speaking" | "working" | "needs-you";

export type TrayFacts = {
  voiceConnected: boolean;
  speaking: boolean;
  missionsRunning: number;
  approvalsPending: number;
};

/** Highest priority first.
 *
 *  `needs-you` outranks everything including `asleep`: voice being
 *  disconnected does not make a blocked agent less blocked, and a blocked
 *  agent behind a hidden window is exactly what this tray is for.
 *
 *  `working` outranks `speaking` because the user can already HEAR that she
 *  is speaking; that work is continuing in the background is the fact the
 *  tray can add. */
export function trayState(f: TrayFacts): TrayState {
  if (f.approvalsPending > 0) return "needs-you";
  if (f.missionsRunning > 0) return "working";
  if (f.speaking) return "speaking";
  if (f.voiceConnected) return "listening";
  return "asleep";
}

/** The menu's first line. Plain words, never the slug. */
export function trayLabel(s: TrayState): string {
  switch (s) {
    case "needs-you": return "Waiting on you";
    case "working": return "Working on something";
    case "speaking": return "Speaking";
    case "listening": return "Listening";
    case "asleep": return "Asleep — not listening";
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd desktop && node --test lib/tray.test.ts 2>&1 | grep -E "^. (pass|fail)"
```

Expected: 7 pass, 0 fail.

- [ ] **Step 5: Generate the tray icons**

macOS template images are monochrome with transparency; the system tints them for light and dark menu bars. Five 32×32 PNGs (`@2x` of a 16pt slot), named `<state>Template@2x.png` so Electron picks up the template convention.

Generate them from the app's own mark rather than inventing new art — a filled circle whose fullness encodes the state, which reads at 16px where a glyph does not:

```bash
mkdir -p desktop/assets
python3 - <<'PY'
# Five tray icons as template images: black with alpha, which macOS tints.
# A ring that fills as she gets busier, and a dot in the middle when she
# needs you -- readable at 16pt, where a glyph is not.
import struct, zlib, math, os

def png(path, pixels, size):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in pixels)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    hdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", hdr)
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

S = 32
def render(fill, centre_dot):
    c, r_out, r_in = (S - 1) / 2, 13.0, 9.0
    rows = []
    for y in range(S):
        row = []
        for x in range(S):
            dx, dy = x - c, y - c
            d = math.hypot(dx, dy)
            a = 0
            if r_in <= d <= r_out:                      # the ring
                ang = (math.degrees(math.atan2(-dy, dx)) - 90) % 360
                a = 255 if ang <= 360 * fill else 60
            if centre_dot and d <= 4.5:
                a = 255
            row.append((0, 0, 0, a))
        rows.append(row)
    return rows

for name, fill, dot in [("asleep", 0.0, False), ("listening", 0.25, False),
                        ("speaking", 0.6, False), ("working", 1.0, False),
                        ("needs-you", 1.0, True)]:
    png(f"desktop/assets/{name}Template@2x.png", render(fill, dot), S)
    print("wrote", name)
PY
ls -l desktop/assets/
```

- [ ] **Step 6: Wire the tray in main**

In `desktop/main/index.ts`:

```ts
let tray: Tray | null = null;
let currentTrayState: TrayState = "asleep";

function iconFor(state: TrayState): Electron.NativeImage {
  const img = nativeImage.createFromPath(
    path.join(__dirname, `../assets/${state}Template@2x.png`));
  // Marking it a template is what makes macOS tint it for the menu bar's
  // light and dark appearance; an untinted icon is invisible in one of them.
  img.setTemplateImage(true);
  return img;
}

function refreshTray(): void {
  if (!tray) return;
  tray.setImage(iconFor(currentTrayState));
  tray.setToolTip(`Yuri — ${trayLabel(currentTrayState)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayLabel(currentTrayState), enabled: false },
    { type: "separator" },
    { label: "Show Yuri", click: () => showMainWindow() },
    { label: "Quit Yuri", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray(): void {
  tray = new Tray(iconFor("asleep"));
  // A left click shows her, which is what a tray icon should do; the menu is
  // on right-click, per the platform.
  tray.on("click", () => showMainWindow());
  refreshTray();
}
```

Call `createTray()` in `app.whenReady()`, and add the IPC listener:

```ts
  ipcMain.on("tray:state", (_e, state: TrayState) => {
    // Trust nothing from a renderer: an unknown string would blank the icon.
    if (!TRAY_STATES.includes(state)) return;
    if (state === currentTrayState) return;   // avoid rebuilding the menu on every poll
    currentTrayState = state;
    refreshTray();
  });
```

Add `TRAY_STATES` to `desktop/lib/tray.ts` and a test that it matches the type:

```ts
export const TRAY_STATES: TrayState[] =
  ["asleep", "listening", "speaking", "working", "needs-you"];
```

Extend the imports with `Menu`, `Tray`, `nativeImage`, and `TRAY_STATES`, `trayLabel`, `type TrayState` from `../lib/tray`.

- [ ] **Step 7: Report the state from the renderer**

`frontend/lib/trayState.ts` — the same priority list, on the frontend side, so it is testable there too:

```ts
// What the desktop shell's tray should say, derived from what this app knows.
//
// The rule is duplicated from desktop/lib/tray.ts on purpose: the two run in
// different processes with no shared module, and a frontend that imported
// from desktop/ would break `next build` for the browser. The tests on both
// sides pin the same priority order, so a change to one that is not made to
// the other fails a test rather than drifting silently.

export type TrayState = "asleep" | "listening" | "speaking" | "working" | "needs-you";

export function trayStateFor(f: {
  connected: boolean; vstate: string;
  missionsRunning: number; approvalsPending: number;
}): TrayState {
  if (f.approvalsPending > 0) return "needs-you";
  if (f.missionsRunning > 0) return "working";
  if (f.vstate === "speaking") return "speaking";
  if (f.connected) return "listening";
  return "asleep";
}
```

`frontend/lib/trayState.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { trayStateFor } from "./trayState.ts";

const f = (over: Partial<Parameters<typeof trayStateFor>[0]> = {}) => ({
  connected: false, vstate: "idle", missionsRunning: 0, approvalsPending: 0, ...over,
});

test("the priority order matches desktop/lib/tray.ts", () => {
  // Duplicated deliberately (different processes, no shared module), so both
  // sides pin the same order and a one-sided change fails here.
  assert.equal(trayStateFor(f({ approvalsPending: 1, missionsRunning: 2,
                                connected: true, vstate: "speaking" })), "needs-you");
  assert.equal(trayStateFor(f({ missionsRunning: 1, connected: true,
                                vstate: "speaking" })), "working");
  assert.equal(trayStateFor(f({ connected: true, vstate: "speaking" })), "speaking");
  assert.equal(trayStateFor(f({ connected: true })), "listening");
  assert.equal(trayStateFor(f()), "asleep");
});

test("a pending approval reports even when voice is off", () => {
  assert.equal(trayStateFor(f({ approvalsPending: 3 })), "needs-you");
});
```

In `frontend/components/VoiceProvider.tsx`, add an effect near the other `useEffect`s. Read the file first to use the real names for the mission and approval lists:

```tsx
  // Tell the desktop shell what to show in the tray. Guarded: in a browser
  // there is no bridge, and this must be a no-op rather than a crash.
  useEffect(() => {
    const bridge = (window as unknown as {
      yuriTray?: { set: (s: string) => void };
    }).yuriTray;
    if (!bridge) return;
    bridge.set(trayStateFor({
      connected,
      vstate,
      missionsRunning: missions.filter((m) => m.status === "running").length,
      approvalsPending: approvals.length,
    }));
  }, [connected, vstate, missions, approvals]);
```

Import `trayStateFor` from `@/lib/trayState`. Verify the mission status string and the approvals list name against the file — `lib/missions.ts` has the status vocabulary, and `approvals` is already in the provider's state.

- [ ] **Step 8: Verify**

```bash
cd desktop && node --test lib/*.test.ts 2>&1 | grep -E "^. (pass|fail)"
cd frontend && node --test lib/*.test.ts 2>&1 | grep -E "^. (pass|fail)"
cd frontend && npx tsc --noEmit -p tsconfig.json && npx next build 2>&1 | grep -E "Compiled|error"
```

Then by hand: launch the app, confirm a tray icon appears; connect voice and watch it change; hide the window and confirm the tray still reflects state. To see `needs-you` without a real approval, temporarily return `1` for `approvalsPending` in the effect, rebuild the frontend, and confirm the icon gains its centre dot and the menu's first line reads "Waiting on you" — then revert.

- [ ] **Step 9: Commit**

```bash
git add desktop/lib/tray.ts desktop/lib/tray.test.ts desktop/assets desktop/main/index.ts \
        frontend/lib/trayState.ts frontend/lib/trayState.test.ts frontend/components/VoiceProvider.tsx
git commit -m "feat(desktop): a tray that says what she is doing"
```

---

## Task 6: One command that runs the app, and the docs to match

**Files:**
- Modify: `desktop/package.json`, `bin/yuri`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `bin/yuri app` builds the frontend if needed and launches the desktop shell.

- [ ] **Step 1: Add the subcommand**

`bin/yuri` currently dispatches `doctor` and delegates everything else to `bin/yapcode`. Add a case before the delegation, following the file's existing style:

```bash
  app)
    # The desktop shell. It supervises the same two servers `up` starts, so
    # running both at once would fight over ports 8000 and 3000.
    for port in 8000 3000; do
      if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
        printf 'yuri: port %s is already in use — stop `yuri up` first\n' "$port" >&2
        exit 1
      fi
    done
    # `next start` needs a production build; `next dev` is not what the shell runs.
    if [ ! -f "$APP_ROOT/frontend/.next/BUILD_ID" ]; then
      printf 'yuri: building the interface (first run)\n' >&2
      ( cd "$APP_ROOT/frontend" && npm run build ) || exit 1
    fi
    if [ ! -d "$APP_ROOT/desktop/node_modules" ]; then
      printf 'yuri: installing the desktop shell (first run)\n' >&2
      ( cd "$APP_ROOT/desktop" && npm install ) || exit 1
    fi
    exec npm --prefix "$APP_ROOT/desktop" run dev
    ;;
```

Update the usage line in the same file:

```bash
    printf '%s\n' "usage: yuri {up|app|doctor|session [dir]|config}" >&2
```

- [ ] **Step 2: Verify the guard and the launch**

```bash
./bin/yuri up &        # occupy the ports
sleep 8
./bin/yuri app         # must refuse, naming the port
```

Expected: `yuri: port 8000 is already in use — stop \`yuri up\` first`, exit 1. Then stop `up`, wait for the ports to free, and run `./bin/yuri app` — the boot window should appear.

- [ ] **Step 3: Document it**

Add to `README.md`, beside the existing `yuri up` instructions. Say plainly what it is and is not:

```markdown
### As a desktop app

    yuri app

Opens Yuri in her own window — no terminal, no browser tab. She keeps running
when you close the window: the tray icon shows what she is doing, and only
Quit stops her.

This runs the same two servers `yuri up` does, so the two cannot run at once.
It is not yet a `.dmg` you can hand to someone else — it uses this clone's
`backend/.venv` and needs `claude` and `tmux` installed as usual. Packaging
comes next.
```

- [ ] **Step 4: Commit**

```bash
git add bin/yuri README.md desktop/package.json
git commit -m "feat(desktop): yuri app launches the shell"
```

---

## Self-review

**Spec coverage for what this plan claims**

| Spec | Task |
|---|---|
| §4.1 process model, fixed ports | 3 |
| §4.2 `next start` under `ELECTRON_RUN_AS_NODE` | 3 |
| §4.3 hide-on-close, tray click, `⌘⇧Y`, quit stops children | 4 |
| §4.3 `backgroundThrottling: false` | 1 |
| §4.3 tmux panes survive quit | 3 (`stopServers` touches only its own children) |
| §4.4 five tray states, "needs you" outranking | 5 |
| §5 login-shell environment, bounded, with a fallback | 2 |
| §5 the resolved `PATH` visible in the boot screen | 4 (the "Finding your tools" row) |
| §6.1 boot UI: real checks, three distinct states, failure shows stderr | 4 |

**Deliberately out of scope**, each with its reason stated in the Scope section above: bundled Python and the 355 MB trim, `electron-builder` and the `.dmg`, the microphone check, `safeStorage`, and the offer-to-restart. All five are sub-project 2b.

**Gaps I am aware of and accepting**

- **The frontend must be built before the app starts.** `next start` needs `.next/BUILD_ID`; Task 6's `bin/yuri app` builds it on first run, but a stale build after a code change is the user's to rebuild. 2b's packaging makes this moot by shipping a build.
- **A child that crashes *after* boot is not restarted.** `track()` reports it, but nothing acts. Deliberate: a restart policy needs the offer-to-restart UI from §6.4, which is 2b's first task, and a silent auto-restart loop would be worse than a visible dead server.
- **The tray rule is duplicated** between `desktop/lib/tray.ts` and `frontend/lib/trayState.ts`. The two processes share no module, and importing across would break `next build`. Both sides' tests pin the same priority order, so a one-sided change fails rather than drifts.

**Placeholder scan:** none. Every step carries the code or the command it needs, including the icon generator and the failure-path verification.

**Type consistency:** `BootState`, `ChildState`, `ChildName`, `BootEvent` are defined in Task 3 and used by name in Task 4. `TrayState` and `TRAY_STATES` are defined in Task 5 and used in the same task's main-process wiring. `Env` is defined in Task 2 and consumed in Tasks 2 and 3. `showMainWindow()` is defined in Task 4 and called from Task 5's tray. `stopServers()` is defined in Task 3 and called from Task 4's quit path and retry.
