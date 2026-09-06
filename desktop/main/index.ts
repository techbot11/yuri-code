// Yuri OS desktop shell: the main process.
//
// Deliberately thin. Every decision that can be wrong in a way nobody
// notices -- which environment the children get, whether the boot is ready
// or failed, which tray state a set of facts means -- lives in ../lib as a
// pure function with tests, because there is no Electron test environment.
import { app, BrowserWindow, globalShortcut, ipcMain, shell, systemPreferences } from "electron";
import * as path from "node:path";
import {
  applyBootEvent,
  bootPhase,
  initialBoot,
  type BootState,
  type ChildState,
} from "../lib/boot";
import { mergeEnv, withFallbackPath, type Env } from "../lib/env";
import { MIC_SETTINGS_URL, normalizeMicStatus, type MicStatus } from "../lib/mic";
import { externalOpenScheme, isAppUrl } from "../lib/urls";
import { portsFromEnv } from "../lib/ports";
import { startServers, stopServers } from "./servers";
import { homeDir, probeLoginEnv } from "./shellEnv";
import { createTray, setTrayState } from "./tray";

// Overridable so a verification run can point the shell at other ports
// without fighting a `bin/yuri up` the developer already has running; absent,
// the shipping defaults (8000/3000) apply. See lib/ports.ts.
const ports = portsFromEnv(process.env);
const FRONTEND_URL = `http://localhost:${ports.frontend}`;

// How long the window waits, hidden, for the frontend before showing
// SOMETHING rather than nothing. Measured: `next start` answers in ~188ms,
// so almost no boot ever reaches this -- it exists for the rare slow one
// (a cold Next compile, a loaded machine), not the common case.
const SPLASH_DELAY_MS = 3000;

// Named so the failure log can say which accelerator was refused.
const SHOW_ACCELERATOR = "CommandOrControl+Shift+Y";

let mainWindow: BrowserWindow | null = null;
// Set by before-quit, and read by the window's close handler so a real quit
// can actually destroy the window. NOTHING else writes it: a call site that
// sets it first (boot:quit used to) makes before-quit's own re-entry guard
// skip the drain, orphaning both children holding their ports while the app
// exits anyway via the default window-all-closed path.
let quitting = false;
// Guards EVERY boot cycle end-to-end -- the initial one and each retry
// (stopServers()'s drain, then a fresh boot()) -- up to the point the window
// has something to show, but not the backend's own health poll, which
// continues in the background after boot() returns (see boot()'s comment).
// Two overlapping cycles would fight over shared, unguarded mutable state:
// mainWindow, and servers.ts's list of live cycles -- a second retry click
// while one cycle is in flight can SIGTERM children the first click only
// just spawned, or leave the window pointed at a boot that has been drained.
// See runBootCycle(), the only writer.
let booting = false;

/** Hand a URL to the user's browser -- but only a web URL.
 *
 *  isAppUrl() hardened the DECISION to navigate; the ACTION behind it was
 *  left open, and shell.openExternal() will ask the OS to open a `file:` or
 *  a custom scheme, which on macOS can launch a local application. See
 *  externalOpenScheme() for the rule. Prophylactic rather than a live hole
 *  -- no path in this app renders an attacker-controlled link today -- and
 *  it belongs beside the origin check it now sits next to.
 *
 *  Logs the SCHEME only, never the URL: a URL can carry a token in its
 *  query, and this log is the wrong place to find that out. */
function openExternally(url: string): void {
  const { ok, scheme } = externalOpenScheme(url);
  if (!ok) {
    console.error(`[yuri] refusing to open a "${scheme}" URL outside the app`);
    return;
  }
  void shell.openExternal(url);
}

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
      // Load-bearing, not a preference: Electron throttles timers in a hidden
      // window, and this app's premise is that a hidden window keeps talking.
      backgroundThrottling: false,
    },
  });

  // Anything that is not the app opens in the user's real browser. Without
  // this, a link in a transcript would navigate the app away from Yuri with
  // no way back -- there is no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, FRONTEND_URL)) {
      event.preventDefault();
      openExternally(url);
    }
  });

  // HIDE, never destroy. A destroyed renderer takes the voice session, the
  // WebSocket, the microphone and the conversation with it -- and the whole
  // premise of this app is that closing the window leaves her running.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // No 'minimize' handler, deliberately (considered, not forgotten): Electron
  // fires it AFTER the OS already minimized the window and it is not
  // cancelable, so hiding in response would only add a flicker -- the genie
  // animation plays, then the window vanishes from the Dock -- for no
  // benefit. A minimized renderer is not destroyed, which is the property
  // this app actually needs, and showMainWindow()'s win.show() un-minimizes
  // exactly as well as it un-hides.

  return win;
}

/** Escape text going into the minimal page's HTML (never into a live DOM via
 *  textContent, since this page is built as a string -- see minimalPageUrl).
 *  Untrusted in the sense that matters here: `detail` is a child process's
 *  own stderr, which can contain literal `<`/`&` (a Python traceback's
 *  `File "<string>"`, say) that would otherwise corrupt the page. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The ONLY native UI left once the frontend owns its own boot screen: a
 *  small, generic page for the two situations where there is no frontend to
 *  show anything in yet -- a slow first paint (`failed: false`, no buttons,
 *  matching the "Starting Yuri…" the frontend shows for the same wait) and
 *  the frontend itself failing to start (`failed: true`, with whatever
 *  stderr was captured, and Retry/Quit). Deliberately not a port of the old
 *  boot/index.html: no per-service checklist, because the frontend is the
 *  only thing this page ever waits on now. A `data:` URL rather than a file
 *  on disk -- this is meant to be rare and small enough not to need one. */
function minimalPageUrl(opts: { failed: boolean; detail: string }): string {
  const html = `<!doctype html>
<meta charset="utf-8" />
<title>Yuri OS</title>
<style>
  :root {
    --bg: #1a1917; --panel: #211f1d; --ink: #e9e3d8; --mut: #928c81;
    --acc: #dd8a6a; --line: #322f2b;
  }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px ui-sans-serif, system-ui, -apple-system, sans-serif;
    display: grid; place-items: center; height: 100vh;
  }
  .card { width: 360px; text-align: center; }
  p { color: var(--mut); margin: 0 0 14px; }
  pre {
    text-align: left; margin: 0 0 14px; padding: 10px 12px; max-height: 160px;
    overflow: auto; background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; font: 11.5px ui-monospace, Menlo, monospace;
    color: var(--mut); white-space: pre-wrap;
  }
  .actions { display: flex; gap: 8px; justify-content: center; }
  button {
    font: inherit; font-size: 12.5px; color: var(--ink); background: none;
    border: 1px solid var(--line); border-radius: 999px; padding: 5px 14px;
    cursor: pointer;
  }
  button:hover { border-color: var(--acc); color: var(--acc); }
</style>
<div class="card">
  <p>${opts.failed ? "Yuri could not start" : "Starting Yuri…"}</p>
  ${opts.failed && opts.detail ? `<pre>${escapeHtml(opts.detail)}</pre>` : ""}
  ${opts.failed ? `<div class="actions">
    <button id="retry">Try again</button>
    <button id="quit">Quit</button>
  </div>` : ""}
</div>
<script>
  document.getElementById("retry")?.addEventListener("click", () => window.yuriBoot?.retry());
  document.getElementById("quit")?.addEventListener("click", () => window.yuriBoot?.quit());
</script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Push the current boot state to the frontend. `env`/`envDetail` cover the
 *  shell-probe row, which is not part of BootState (it finishes before
 *  startServers begins and never fails outright, only falls back). A no-op
 *  once the window is gone (only possible while the app is quitting) rather
 *  than sending into -- or closing -- a destroyed window.
 *
 *  Reaches whatever is currently loaded: the frontend's own SetupGate once
 *  the app is showing (frontend is trivially "ready" by then -- it is what
 *  rendered the page listening), or nothing at all before anything has
 *  loaded (dropped; there is no listener yet, and the eventual load of the
 *  minimal page bakes in the state already known at that point instead of
 *  relying on a push landing before its listener exists). */
/** The last payload pushed, kept so a renderer that mounts LATER can still
 *  learn the current state. Every state change here happens before the
 *  window's JS runs -- the environment resolves, both children spawn, and
 *  the frontend reports ready, all before a React effect has subscribed --
 *  so a channel with no replay delivers the boot's whole story to nobody.
 *  That is not a rare race; it is the normal order of events. */
let lastBoot: unknown = null;

/** The current TCC status. Read fresh each time rather than cached: the user
 *  can change it in System Settings while the app is running, and a cached
 *  "denied" would keep saying so after they fixed it. */
function micStatus(): MicStatus {
  if (process.platform !== "darwin") return "unknown";
  return normalizeMicStatus(systemPreferences.getMediaAccessStatus("microphone"));
}

function pushBoot(state: BootState, env: ChildState, envDetail = ""): void {
  // Recorded BEFORE the window guard: the pushes that arrive with no window
  // yet are exactly the ones a late subscriber needs replayed.
  lastBoot = {
    phase: env === "failed" ? "failed" : bootPhase(state),
    env,
    envDetail,
    backend: state.backend,
    frontend: state.frontend,
    errorDetail: state.error?.detail || "",
    mic: micStatus(),
  };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("boot:state", lastBoot);
}

/** Wait for the FRONTEND only, then show it -- the backend wait is now the
 *  frontend's own job, in its own theme (SetupGate + lib/backendWait.ts).
 *  startServers() itself still checks both children in parallel and keeps
 *  reporting backend progress via pushBoot for as long as it takes (up to
 *  its own 60s ceiling), but this function does not block on that: it is
 *  fire-and-forgotten below so a backend that is merely slow, rather than
 *  dead, cannot hold `booting` (and so a retry click from inside the
 *  frontend's own waiting view) hostage behind it. */
async function boot(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  let state = initialBoot();
  pushBoot(state, "starting");

  // The probe is bounded and best-effort; the fallback PATH covers a failure.
  const probed = await probeLoginEnv();
  const env = withFallbackPath(mergeEnv(process.env as Env, probed), homeDir());
  // Names only, never values: this string reaches a window, and the
  // environment carries ANTHROPIC_AUTH_TOKEN and friends.
  const envDetail = probed ? "from your shell" : "using known locations";
  pushBoot(state, "ready", envDetail);

  let frontendDetail = "";
  let settleFrontend: () => void = () => {};
  const frontendSettled = new Promise<void>((resolve) => { settleFrontend = resolve; });

  // Not awaited: see this function's own comment above. Errors from
  // startServers() itself (as opposed to a child failing, which arrives as
  // an ordinary BootEvent) are not expected, but must not vanish silently.
  void startServers(
    env,
    (ev) => {
      state = applyBootEvent(state, ev);
      pushBoot(state, "ready", envDetail);
      if (ev.type === "failed" && ev.child === "frontend") frontendDetail = ev.detail;
      if (ev.child === "frontend") settleFrontend();
    },
    ports,
  ).catch((err) => {
    console.error("[yuri] startServers() rejected:", err instanceof Error ? err.message : err);
    // Not an ordinary BootEvent (something in startServers() itself threw,
    // rather than a child failing cleanly) -- but frontendSettled must still
    // resolve, or a bug here would hang boot() forever with the window
    // showing nothing. Frontend, not backend: nothing can show without it,
    // regardless of which child startServers() was working on when it threw.
    if (state.frontend === "starting") {
      state = applyBootEvent(state, {
        type: "failed", child: "frontend", detail: "the desktop shell failed to start it",
      });
      frontendDetail ||= "the desktop shell failed to start it";
      settleFrontend();
    }
  });

  const splashTimer = setTimeout(() => {
    if (state.frontend === "starting" && mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(minimalPageUrl({ failed: false, detail: "" }))
        .then(() => mainWindow?.show());
    }
  }, SPLASH_DELAY_MS);

  await frontendSettled;
  clearTimeout(splashTimer);

  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (state.frontend === "ready") {
    await mainWindow.loadURL(FRONTEND_URL);
  } else {
    await mainWindow.loadURL(minimalPageUrl({ failed: true, detail: frontendDetail }));
  }
  mainWindow.show();
}

/** The ONE way a boot happens -- the first one and every retry alike.
 *
 *  `booting` is held for the cycle's full duration, not just boot()'s share
 *  of it, because a click landing during the ~3.5s stopServers() drain is
 *  just as capable of starting an overlapping cycle as one landing during
 *  boot() itself.
 *
 *  The INITIAL boot goes through here too, which it did not before. That was
 *  survivable only by accident: boot:retry was registered after `await
 *  boot()`, so nothing could ask for a retry until the first boot was over.
 *  Registering the handlers before the boot (which is where they belong --
 *  boot:current's replay must exist before the page that asks for it loads)
 *  removes that accident, and an unguarded initial boot would then be
 *  exactly the overlapping cycle `booting` exists to prevent.
 *
 *  `drainFirst` is the only difference between the two: there is nothing to
 *  drain before the first boot, and calling stopServers() there would add
 *  its sleep to every cold start for no reason. */
async function runBootCycle(drainFirst: boolean): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    if (drainFirst) await stopServers();
    await boot();
  } finally {
    booting = false;
  }
}

export function showMainWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(async () => {
  // Before the window, not after: her presence in the menu bar should not
  // wait on a successful boot, and a failed boot still leaves a tray behind
  // to show something is wrong.
  createTray(showMainWindow);

  // The ONLY BrowserWindow this app ever creates. Hidden until boot() (or
  // the retry cycle it starts over) decides there is something to show.
  mainWindow = createWindow();

  // EVERY handler is registered before the boot, never after it.
  //
  // boot:current is the one that makes this load-bearing: it replays the
  // boot's story to a renderer that mounted after the fact, and boot() ends
  // by loading the page that asks for it. Registering it afterwards happened
  // to work -- loadURL() resolves on did-finish-load while React hydrates in
  // a later task, so the synchronous registration won the race -- but it was
  // a race won by scheduling luck, not by anything guaranteeing it. A page
  // whose script runs inline, before load, loses it.
  //
  // The other three follow it up here rather than being left behind, so that
  // "the bridge exists as soon as a renderer can use it" is one rule instead
  // of a per-channel accident. That makes boot:retry reachable during the
  // initial boot, which is why runBootCycle() now guards that boot too.

  // Returns null when nothing has been pushed yet, which the preload treats
  // as "no news".
  ipcMain.handle("boot:current", () => lastBoot);

  ipcMain.on("boot:retry", () => {
    void runBootCycle(true).catch((err) => {
      console.error("[yuri] retry cycle rejected:", err instanceof Error ? err.message : err);
    });
  });
  // No flag here: before-quit is the only place quitting is set. Setting it
  // at this call site used to make before-quit's own re-entry guard skip the
  // drain, so the app exited via the default window-all-closed path with
  // both children still holding their ports.
  ipcMain.on("boot:quit", () => {
    app.quit();
  });

  ipcMain.on("tray:state", (_e, state: string) => setTrayState(state));

  // Re-read on request, so the splash can refresh after the user visits
  // System Settings without restarting the app.
  ipcMain.handle("mic:status", () => micStatus());

  // mic:settings is the one place a non-http(s) scheme is opened
  // deliberately. externalOpenScheme()/openExternally() above refuse exactly
  // that, because a page could otherwise hand shell.openExternal() a
  // registered scheme that launches a local application -- but
  // MIC_SETTINGS_URL is a compile-time constant in this repo, not a URL any
  // page supplies, so that guard does not apply here. Never pass a
  // page-sourced URL to shell.openExternal directly the way this line does.
  ipcMain.on("mic:settings", () => {
    void shell.openExternal(MIC_SETTINGS_URL);
  });

  // Checked, not assumed: register() returns false when the accelerator is
  // already taken by another app, and an unlogged false is a shortcut that
  // silently does nothing forever.
  if (!globalShortcut.register(SHOW_ACCELERATOR, () => showMainWindow())) {
    console.error(`[yuri] could not register ${SHOW_ACCELERATOR} — ` +
      "another app already owns it, so the show-Yuri shortcut is unavailable " +
      "(the tray icon and the Dock icon still work)");
  }

  // An unhandled rejection here is a boot that stops silently -- the one
  // thing this window exists to prevent -- so it is logged rather than left
  // to vanish into whatever process.on("unhandledRejection") does by default.
  // Only ever the message of our own thrown error, never anything reached
  // via a probe or a spawned child's environment.
  await runBootCycle(false).catch((err) => {
    console.error("[yuri] boot() rejected:", err instanceof Error ? err.message : err);
  });
});

// The ONLY writer of `quitting`, and the ONLY path that stops anything.
// Without the flag, the close handler above would prevent the quit as well
// and the app could never exit; without this being the sole writer, a call
// site that sets it first (⌘Q via the app menu, the boot page's Quit button,
// a future tray "Quit") makes this guard skip the drain instead of running
// it.
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // finally, not then: a stopServers() that rejects must still exit rather
  // than leaving the app un-quittable.
  void stopServers().finally(() => {
    // Was on "will-quit" (unregisterAll() there never ran: app.exit() below
    // skips both before-quit and will-quit by design, and every real quit
    // ends here, so that handler was confirmed-dead code). Doing it here
    // means it actually executes, immediately before the exit it belongs
    // next to -- not that skipping it was ever observable, since the OS
    // reclaims a process-scoped hook on its own.
    globalShortcut.unregisterAll();
    app.exit(0);
  });
});

// macOS: clicking the Dock icon after a hide must bring her back.
app.on("activate", () => showMainWindow());

// Deliberately empty. Two reasons:
//   - Without this, Electron's default is to quit once no windows remain.
//     ⌘W on the (now hidden-by-default) main window while startServers() is
//     still running would fire that default and drain via before-quit before
//     the children exist, while boot()'s in-flight startServers() goes on to
//     spawn them anyway -- orphaning both, holding their ports, with nothing
//     left to stop them.
//   - Now that a tray exists, the app's whole point is to survive having no
//     windows at all (hide-on-close is exactly that state) -- which is also
//     the standard macOS convention.
app.on("window-all-closed", () => {});
