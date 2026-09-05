# Yuri OS as a Desktop App — Design Spec

**Date:** 2026-09-05
**Base:** `main` at `e343e9c`
**Reference implementation:** `~/Projects/project-yuri` — an Electron + daemon app packaged with
`electron-builder`, surveyed at its working tree on 2026-09-05. Where this spec departs from it,
it says why.
**Touches:** new `desktop/`; `backend/config.py`; new backend config API; new frontend setup and
boot surfaces; `bin/`, `packaging/`, `integrations/` for the rename.

---

## 1. What this is for

Yuri runs today as two servers and a browser tab, started from a terminal with `bin/yuri up`.
That has three costs the user named:

1. She is not present. Closing the tab or the terminal ends her; there is nothing on the system
   that says she exists or what she is doing.
2. An agent that blocks on an approval is invisible unless the window happens to be open.
3. Setup requires editing `backend/.env` by hand, which assumes a cloned repo and a text editor.

The goal is a macOS app that behaves like a companion resident on the machine: an icon, a
menu-bar presence that reflects her state, and a lifecycle where only *Quit* stops her. Windows
follows once macOS is stable.

**Explicit constraint from the user: no functionality changes.** Every feature that works today
works the same afterwards. This is a packaging and presence project, not a rewrite.

---

## 2. What Yuri actually depends on

Measured, not assumed — these facts decide the design.

| Dependency | Detail | Bundleable |
|---|---|---|
| Python | 3.14.7, venv at `backend/.venv` | Yes, relocatable build |
| Native wheels | `pydantic_core`, `rpds`, `_cffi_backend`, `charset_normalizer`, `websockets` | Yes, but **arch-specific** |
| Node | Next 16 server, five route handlers under `app/api/` | Not needed separately — see §4.2 |
| `claude` CLI | Required by both backends, but resolved differently — see §2.1. The `cli`/tmux backend needs it on `PATH`; the `sdk` backend ships its own copy inside the wheel | Partly — already is, for the SDK path |
| `tmux` | Required by the `cli` backend, which provides the live terminal pane | No (system tool) |
| `opencode` | Optional, already gated by `YURI_AGENTS` | No |
| Microphone | `getUserMedia` in the renderer; Gemini Live uses `AudioWorklet` + WebSocket, OpenAI Realtime uses `RTCPeerConnection` | n/a |

Two consequences worth stating plainly:

- **Voice needs a real Chromium.** Both transports run in the renderer, and one is full WebRTC.
  Electron bundles Chromium, so this is certain. A WKWebView shell (Tauri) puts it at risk on
  macOS specifically; that is the main reason this spec chooses Electron over the smaller binary.
- **The user must still have authenticated Claude Code**, because a bundled binary carries no
  credentials — but the *binary* is not what the app has to provide for the SDK path. `yuri
  doctor` already checks this and becomes the first-run gate (§6.2).

### 2.1 How `claude` is resolved, and a live inconsistency it causes

Measured against `claude_agent_sdk==0.2.87`. `SubprocessCLITransport._find_cli()`
(`_internal/transport/subprocess_cli.py:81-112`) tries, in order:

1. `_bundled/claude` **inside the installed wheel** — a 204 MB executable the SDK ships
2. `shutil.which("claude")`
3. six absolute fallbacks, including `~/.claude/local/claude` and `/usr/local/bin/claude`

Three consequences:

- **The SDK backend does not need `claude` on `PATH` at all.** Step 1 wins, and steps 3's absolute
  paths would cover a launchd environment anyway. §5's `PATH` problem therefore bites only the
  `cli`/tmux backend and the `tmux` lookup itself — a narrower blast radius than first assumed,
  but not zero.
- **The bundle is much larger than a stripped interpreter suggests.** Measured: 25 MB download,
  68 MB unpacked interpreter, **355 MB** once the locked requirements are installed — of which
  204 MB is that one bundled CLI and 259 MB is `__pycache__`. Trimming `__pycache__`, `pip`,
  `setuptools` and test directories is therefore not optional housekeeping; it is most of the
  payload. Whether the bundled CLI can be deleted in favour of the user's own installation is an
  open question for the plan, and worth answering: it is over half the remainder.
- **There is a version skew in the app today, unrelated to packaging.** The bundled CLI is
  `2.1.150`; the machine this was measured on has `2.1.261` on `PATH`. So a `cli`-backend session
  and an `sdk`-backend session run *different Claude Code versions*, silently. This predates the
  desktop work and should be fixed on its own merits — the plan should surface the resolved path
  and version per backend rather than leave it invisible.

---

## 3. Approaches considered

**A. Electron supervises both servers and loads `localhost:3000`.** — **chosen**

The main process spawns bundled-Python uvicorn on 8000 and `next start` on 3000, waits for both
to answer, then loads the URL. Nothing in the app changes: same Next server, same route
handlers, same auth-token path, same voice code.

Cost: two children to supervise, two health checks, two shutdown paths, and a boot that waits for
both. This is the closest analogue to project-yuri, which forks one daemon; Yuri forks two.

**B. Static-export Next, `loadFile`, renderer talks to `:8000` directly.** — rejected

One child, faster boot, no Node inside Electron. But it deletes the five route handlers, which
carry the LAN auth-token injection and `blockCrossSite`. Re-implementing those elsewhere is a
functionality change, which the user ruled out.

**C. Port the UI into an electron-vite renderer, as project-yuri has.** — rejected

The cleanest end state and an exact match for the reference. Also a full frontend rewrite.
Ruled out by the same constraint.

---

## 4. Architecture

### 4.1 Process model

```
Electron main (Node)
├── resolves the user's real environment  (§5)
├── child: bundled python -m uvicorn main:app --port 8000
├── child: next start --port 3000        (via ELECTRON_RUN_AS_NODE)
├── BrowserWindow  → http://localhost:3000
├── Tray           → Yuri's state (§4.4)
└── boot window    → local HTML, shown before either child is ready (§6.1)
```

Ports stay 8000 and 3000. They are already configurable and already what the app assumes; a
desktop app that picked random free ports would break `VC_ALLOWED_ORIGINS` and the LAN-access
feature for no gain.

### 4.2 Why no bundled Node

Electron's main process *is* Node. Spawning `next start` with `ELECTRON_RUN_AS_NODE=1` in the
child's environment runs it on Electron's own Node binary.

**Verified (R3, 2026-09-05).** Electron 35.7.5 carries Node 22.16.0, above Next 16's floor of
20.9.0. Running `node_modules/next/dist/bin/next start` under `ELECTRON_RUN_AS_NODE=1` against a
production build: *Ready in 188ms*, `/` and `/missions/templates` both 200 with real
server-rendered HTML, and the route handler `/api/yuri/templates` returned 200 — so server-side
code, which is the part option B would have deleted, runs correctly. No bundled Node is needed.

### 4.3 Lifecycle

| Event | Behaviour |
|---|---|
| Launch | spawn both children, show boot window, wait for both to answer, then show the main window |
| Close (⌘W / red button) | `event.preventDefault()` then `window.hide()` — **never destroy** |
| Minimise | `window.hide()` |
| Tray click | `window.show()` — same renderer, same conversation, no voice reconnect |
| Global shortcut | `⌘⇧Y` shows and focuses; the replacement for the mini window the user declined |
| Quit (⌘Q / tray) | the only stopping path: SIGTERM uvicorn, kill Next, then exit |

**Hiding rather than destroying is the mechanism that makes the whole requirement work.** A
destroyed renderer takes the voice session, the WebSocket, the mic and the conversation with it.
Two settings are therefore load-bearing, not preferences:

- `backgroundThrottling: false` on the window's `webPreferences`. Electron throttles timers in
  hidden windows by default, which would stutter audio and delay the event stream.
- The `close` handler must distinguish hide-on-close from a real quit, or ⌘Q leaks both children.
  A module-level `quitting` flag set in `before-quit` is the conventional shape.

On quit, tmux panes are deliberately **left running**. `VC_KILL_SESSIONS_ON_SHUTDOWN` already
defaults off so a restart can rehydrate them; quitting the UI must not kill an agent mid-task.

### 4.4 The tray is her presence

The tray reflects state the backend already emits. The renderer subscribes to the event bus as it
does today and forwards state to main over IPC — no second connection to the backend, and no new
backend surface.

| State | Condition | Why it earns a slot |
|---|---|---|
| Asleep | voice not connected | honest: she is not listening |
| Listening | voice connected, idle | the resting state |
| Speaking | assistant audio playing | so you know before interrupting |
| Working | ≥1 mission `running` | she is doing something while you are elsewhere |
| **Needs you** | an approval is pending | **the state that justifies the tray** |

"Needs you" is the point. Today a blocked agent is invisible behind a hidden window; this makes
it visible on the menu bar. The other four are context.

Tray menu: current state as a disabled first line, then Show Yuri · Mute · Quit.

The Dock icon stays visible. She is an app, not a menu-bar utility.

---

## 5. The environment problem

A macOS `.app` launched from the Dock inherits **launchd's** environment, not the user's shell.
Its `PATH` is approximately `/usr/bin:/bin:/usr/sbin:/sbin`. Therefore:

- `shutil.which("claude")` returns `None` in the packaged app **even though it works in a
  terminal**, and every agent session fails at spawn.
- `shutil.which("tmux")` likewise.
- Any `ANTHROPIC_*` value exported from `~/.zshrc` is absent.

This is the same bug class already diagnosed twice in this codebase: `~/.zshrc` is read only by
interactive shells, so tmux panes never saw `ANTHROPIC_AUTH_TOKEN`; and `--model` was pinned over
the user's own configuration. In each case a narrower context silently overrode the user's real
intent.

**Design:** at startup, before spawning anything, main resolves the user's login environment once
by running their shell as a login+interactive shell and reading `env`. That environment — merged
over `process.env`, with the app's own credentials layered on top (§6.3) — is what both children
receive.

Requirements on this step:

1. It must not block the boot window. Resolve it while the window is already visible.
2. It must survive a shell that hangs or prints noise: a timeout with a documented fallback to
   `process.env` plus the common install locations (`/opt/homebrew/bin`, `/usr/local/bin`,
   `~/.local/bin`, `~/.bun/bin`, and the active Node prefix's `bin`).
3. The resolved `PATH` must be reported in the doctor screen, because "which `claude` did it
   find" is the first question when a session fails.

---

## 6. Configuration, credentials, and setup

This section is new work the user asked for, and it is the largest behavioural addition.

### 6.1 Boot UI

The boot window is **local HTML loaded by Electron**, not a Next route — it has to be on screen
before Next exists. It shows, in order, what is actually happening:

```
Starting Yuri
  ✓ found your environment      (claude 2.1.x · tmux 3.7)
  ✓ backend ready               (:8000)
  … frontend starting           (:3000)
```

Each line is a real check, not a spinner with a fixed delay. Failure is a state, not a hang: if a
child exits or a port never answers within its timeout, the boot window shows the child's last
stderr and offers Retry, Open logs, and Quit. The three states — starting, ready, failed — must
look different, per `docs/yuri/design/GUIDE.md`.

### 6.2 First-run and the doctor screen

`yuri doctor` already checks exactly the right list: allowed roots, `claude`, `tmux`, voice keys,
agents, opencode. It becomes a UI surface rather than new logic.

- A new backend endpoint exposes the doctor's findings as data (§6.5), so one implementation
  serves both the CLI and the app.
- On first run, or whenever a **required** check fails, the app shows the doctor screen instead of
  the main UI. Required means: `claude` present, and at least one voice key configured.
- Each failing check carries the action that fixes it. `claude` missing links to Claude Code's
  install page; `tmux` missing shows `brew install tmux` as copyable text and explains what is
  lost without it (the live terminal pane) rather than blocking.

### 6.3 Credentials come from the app, not a file

Today keys live in `backend/.env` (chmod 600), edited by hand. The user's requirement: enter them
in the app, have them loaded on every start, and be able to change them later.

**Storage:** Electron `safeStorage`, which encrypts against the macOS Keychain. Ciphertext is
written to `~/Library/Application Support/Yuri OS/credentials.enc`; plaintext never touches disk.
Main decrypts at startup and passes the values to both children as environment variables.

Note the two locations and the line between them: `~/Yuri` remains her **data** — journal,
memories, templates, workspace — user-visible and user-editable, unchanged by this project.
`Application Support` holds only app-private encrypted state. Nothing moves out of `~/Yuri`.

This is a real improvement over `.env`, not just a relocation: the secrets stop being readable by
any process running as the user.

**Managed values.** Voice: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY` (the
existing `VOICE_KEY_VARS`). Anthropic: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` — the four the user exports from `~/.zshrc` today. Putting
these in the app is the durable fix for §5: a custom model or gateway configured here reaches
every agent session regardless of how the app was launched.

**A precedence bug must be fixed for any of this to work.** `config.py:63` loads `backend/.env`
with `override=True`, so the file **overwrites** real environment variables. A leftover
`backend/.env` in a development tree would silently beat everything the app passes — the third
instance of this codebase's recurring failure. The precedence becomes:

```
real environment  >  $YAPCODE_CONFIG_DIR/.env  >  backend/.env
```

That is the conventional order and the one that makes an explicitly-passed credential win.
`ENV_SOURCES` already records provenance per key, so the settings UI can say where each value
came from — which is how a user discovers a stale file is shadowing them.

**Safety rule:** the config API returns **presence and a masked hint only** (`sk-…4f2a`), never a
secret value, in any response, log, or error. A GET that could return a key would put every key
one XSS away from exfiltration.

### 6.4 What a change takes effect on

Honest, because it is not uniform:

| Setting | Effect | Why |
|---|---|---|
| Voice keys | **next voice connect** | read live via `os.getenv` at token-mint time |
| `ANTHROPIC_*` | **next agent session** | passed to the `claude` child at spawn |
| `YURI_HOME`, `YURI_AGENTS`, `OPENCODE_URL`, `ALLOWED_PROJECT_ROOTS`, ports | **restart required** | frozen into module constants at import (`config.py:131-199`) |

The settings UI must label the third group as needing a restart and offer to do it — the desktop
app can restart its own backend cleanly because it owns the child, which the browser version
never could. It must refuse to restart while a mission is running, or say what it will interrupt.

### 6.5 Backend surface

Three endpoints, loopback-and-token-gated like the rest of the API:

- `GET /yuri/doctor` — the existing checks as structured data: `{check, ok, detail, fixable}`.
  Reuses `yuri/doctor.py`; the CLI keeps printing the same findings.
- `GET /yuri/config` — every managed key: whether it is set, a masked hint, and its provenance
  from `ENV_SOURCES`. **Never a value.**
- `PUT /yuri/config` — validates and reports which of §6.4's three categories the change falls
  into. It does **not** write the credential store; main owns that. The endpoint exists so the
  renderer gets validation and effect-scope from one place.

Writing goes renderer → IPC → main → `safeStorage`. Secrets never transit HTTP, not even on
loopback.

---

## 7. The `yapcode` → `Yuri OS` rename

309 occurrences across 34 files. They are not one job, and a blind rename breaks working
installations. Three categories, in increasing risk:

**7.1 Prose and user-facing strings — rename now, no compatibility burden.**
README, SECURITY.md, help text, log messages, comments, the `"yapcode is running"` line,
`missing_key_detail`'s advice (which will be wrong anyway once §6.3 lands — it tells the user to
run `yapcode config`).

**7.2 Product and file names — rename now, with the aliases they need.**
`bin/yapcode` → `bin/yuri-os` with `bin/yapcode` kept as a thin forwarding shim, because
`integrations/claude-code-plugin` and `packaging/release.sh` exec it by name. `packaging/yapcode.rb`
→ `packaging/yuri-os.rb` is a Homebrew formula rename, which breaks `brew upgrade` for any existing
install; acceptable, but it must be stated in the release notes rather than discovered.
The `yapcode.runner` logger name is asserted in `backend/tests/test_tmux_rehydrate.py:203`, so it
renames together with its test.

**7.3 Environment variable names — do NOT rename in this project.**
`YAPCODE_CONFIG_DIR`, `YAPCODE_ROOT`, `YAPCODE_TOKEN`, `YAPCODE_URL`, and the twenty-odd `VC_*`
names are a config contract. Renaming them silently breaks every existing `.env`, and `vc_token` /
`vc_auth_token` are worse: the first is a documented URL parameter for phone access, the second a
`localStorage` key whose rename logs every remote user out.

Note also that `VC_*` is **not** a yapcode name — it is an older prefix, and renaming it is a
different project with a different justification.

This is deferred rather than dropped, and §6.3 is the reason it can be: once the app owns
configuration, a user never types these names, so their cost drops to near zero. If they are
renamed later it should be as a compatibility shim — accept both, prefer the new, warn on the old.

---

## 8. Windows, later

Real but reduced. Designed for now only where designing later would mean a rewrite:

- `nsis` target, as in project-yuri's config.
- **SDK backend only.** No tmux, therefore no live terminal pane. `claude_agent_sdk` already
  resolves `claude.exe` on Windows (`subprocess_cli.py:117`), so the path exists.
- The doctor's `tmux` check must be **platform-aware from the start** — on Windows it is not a
  failure, it is a capability that is absent. Building that in now costs one branch; retrofitting
  it means revisiting the doctor's exit-code contract.
- §5's environment resolution is macOS/Linux shaped. Windows GUI apps inherit the user
  environment normally, so the shell probe must be skipped rather than ported.

Everything else — bundled Python, the tray, the lifecycle — is platform-agnostic in shape and
needs only a per-platform build.

---

## 9. Risks, each with the check that settles it

**R1 — Microphone permission on an unsigned app. — RESOLVED, and it is the bad answer.**
*Measured 2026-09-05* with a packaged probe (`electron-builder --dir`, `identity: null`,
`hardenedRuntime: false`, `appId: com.yuri.r1probe`, Electron 35.7.5).

What works:

- `NSMicrophoneUsageDescription` reaches `Info.plist` via `mac.extendInfo`, the TCC prompt appears,
  and after granting it **`getUserMedia` in the renderer succeeds with a real device** — so voice,
  including the WebRTC transport, works in a packaged unsigned Electron app. That was the primary
  question and the answer is yes.
- A grant persists across repeated launches of the *same* build.

What does not:

- **A grant does not survive a rebuild.** Status went `not-determined` → granted (after the
  prompt) → still granted on a second launch → **`not-determined` again after repackaging**.
- This happened even though the `CDHash` was byte-identical before and after (`5c06d5ad…`, stable
  across four rebuilds, because `identity: null` means electron-builder never signs and the
  executable keeps stock Electron's `adhoc,linker-signed` signature while application code sits in
  `Resources/app.asar`). An earlier draft of this spec inferred from that stability that grants
  would survive; **that inference was wrong.** TCC is keying on something the identical cdhash does
  not capture — plausibly the bundle's on-disk identity, destroyed when the build directory is
  replaced. The mechanism is unconfirmed; the behaviour is measured.

Consequences for the plan, which are real:

1. **Every packaged rebuild re-prompts for the microphone during development.** Tolerable, but it
   must be expected rather than diagnosed repeatedly, and it makes "voice broke after a rebuild" a
   known cause rather than a mystery.
2. **Real code signing moves from optional to strongly indicated.** A stable Developer ID
   signature gives TCC a durable identity. This spec still ships unsigned first — the app works —
   but §11's "out of scope" for signing should be read as *deferred*, not *unnecessary*, and it is
   the fix for this if development friction becomes annoying.
3. The boot/doctor screen must **detect `denied` microphone status and say so plainly**, with the
   path to System Settings. A silently-denied mic is otherwise indistinguishable from voice being
   broken — the failure the design guide's "empty, loading and failed never look the same" rule
   exists to prevent.

**R2 — Bundled Python and native wheels. — RESOLVED, with a caveat.**
*Measured 2026-09-05:* `cpython-3.14.7+20260901-aarch64-apple-darwin-install_only_stripped`
(25 MB download, 68 MB unpacked) is relocatable — `sys.prefix` follows wherever it is unpacked.
`pip install -r requirements.lock` into it succeeded, and under a fully scrubbed environment
(`env -i`) all twelve top-level imports work, including every native one: `pydantic_core`, `rpds`,
`charset_normalizer`, `websockets`, `_cffi_backend`.
*The caveat is size, not correctness:* 355 MB installed, against the 50-80 MB this spec first
estimated. §2.1 breaks it down. Trimming is a required build step, and the bundled `claude` is the
single biggest item. Intel/universal remains a separate, later target.

**R3 — Next under `ELECTRON_RUN_AS_NODE`. — RESOLVED.** Verified against Electron 35.7.5 and
Next 16.2.6; see §4.2 for the measurements. No bundled Node, no fallback needed.

**R4 — Boot time.** Two servers plus an environment probe, where a browser tab was instant.
*Check:* measure. If the total exceeds roughly three seconds, the boot window's per-check
feedback (§6.1) is what makes it tolerable, and the environment probe moves off the critical path.

**R5 — Voice while hidden.** `backgroundThrottling: false` is believed sufficient, but a hidden
window holding a WebRTC connection and an `AudioWorklet` for hours is not a well-trodden path.
*Check:* hide the window with voice connected, leave it 30 minutes, confirm she still answers and
that the event stream did not stall.

---

## 10. Testing

The existing suites must keep passing unchanged — 1561 backend, 296 frontend — since §1 forbids
functionality changes. New coverage:

- **Pure and testable in `node --test`:** the tray's state derivation (events → one of five
  states, with "Needs you" outranking "Working"), the boot sequencer's state machine
  (starting/ready/failed per child), and the environment merge (login env over `process.env`,
  credentials over both, fallback paths when the probe fails). These are the parts with real logic
  and they must not live inside Electron callbacks where no test can reach them.
- **Backend `unittest`:** the new precedence in `config.py` (real environment beats both files) —
  this is a behaviour change to existing code and needs a test that would have caught the old
  order. Plus `GET /yuri/config` never returning a secret value, asserted against every managed
  key.
- **Not automated:** TCC permission, the packaged bundle on a clean Mac, and voice-while-hidden.
  These are manual checks with recorded results, because they are properties of a machine rather
  than of code. R1, R2 and R5 name them.

---

## 11. Out of scope

- Signing and notarization for public distribution. Unsigned first, matching the reference.
  **Deferred rather than unnecessary:** R1 measured that an unsigned app loses its microphone
  grant on every rebuild, and a Developer ID signature is the fix. Revisit if that friction bites.
- Auto-update, crash reporting, telemetry.
- The mini window. The user declined it; `⌘⇧Y` replaces the affordance it provided.
- Moving voice into the main process. There is one renderer, so there is no conflict to solve.
- Renaming `VC_*` and `YAPCODE_*` environment variables (§7.3).
- Intel and universal macOS builds; Linux.
