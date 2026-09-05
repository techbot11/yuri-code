// Yuri OS desktop shell: the main process.
//
// Deliberately thin. Every decision that can be wrong in a way nobody
// notices -- which environment the children get, whether the boot is ready
// or failed, which tray state a set of facts means -- lives in ../lib as a
// pure function with tests, because there is no Electron test environment.
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from "electron";
import * as path from "node:path";
import {
  applyBootEvent,
  bootPhase,
  initialBoot,
  type BootState,
  type ChildState,
} from "../lib/boot";
import { mergeEnv, withFallbackPath, type Env } from "../lib/env";
import { isAppUrl } from "../lib/urls";
import { portsFromEnv } from "../lib/ports";
import { startServers, stopServers } from "./servers";
import { homeDir, probeLoginEnv } from "./shellEnv";

// Overridable so a verification run can point the shell at other ports
// without fighting a `bin/yuri up` the developer already has running; absent,
// the shipping defaults (8000/3000) apply. See lib/ports.ts.
const ports = portsFromEnv(process.env);
const FRONTEND_URL = `http://localhost:${ports.frontend}`;

let mainWindow: BrowserWindow | null = null;
let bootWindow: BrowserWindow | null = null;
// Set by before-quit, and read by the window's close handler so a real quit
// can actually destroy the window. NOTHING else writes it: a call site that
// sets it first (boot:quit used to) makes before-quit's own re-entry guard
// skip the drain, orphaning both children holding their ports while the app
// exits anyway via the default window-all-closed path.
let quitting = false;
// Guards the retry cycle end-to-end (stopServers()'s ~3.5s drain, then a
// fresh boot()), not just one half of it. Both stopServers()'s module-level
// children/died state (servers.ts) and mainWindow are shared, unguarded
// mutable state -- a second retry click while one cycle is in flight can
// silently overwrite mainWindow with an orphaned second window, or SIGKILL
// children the second click only just spawned.
let booting = false;

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
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, FRONTEND_URL)) {
      event.preventDefault();
      void shell.openExternal(url);
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

function createBootWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    show: true,
    resizable: false,
    title: "Starting Yuri",
    backgroundColor: "#1a1917",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js") },
  });
  // The default app menu is still active here (no Menu.setApplicationMenu),
  // so ⌘W can close this window mid-boot. Track that so pushBoot() and the
  // success path below stop reaching for a destroyed window instead of
  // throwing inside boot()'s promise chain, where nothing would catch it.
  win.on("closed", () => {
    bootWindow = null;
  });
  void win.loadFile(path.join(__dirname, "../boot/index.html"));
  return win;
}

/** Push the current boot state to the boot window. `env`/`envDetail` cover
 *  the shell-probe row, which is not part of BootState (it finishes before
 *  startServers begins and never fails outright, only falls back). A no-op
 *  once the window is gone (⌘W mid-boot, or the success path already closed
 *  it) rather than sending into -- or closing -- a destroyed window. */
function pushBoot(state: BootState, env: ChildState, envDetail = ""): void {
  if (!bootWindow || bootWindow.isDestroyed()) return;
  bootWindow.webContents.send("boot:state", {
    phase: env === "failed" ? "failed" : bootPhase(state),
    env,
    envDetail,
    backend: state.backend,
    frontend: state.frontend,
    errorDetail: state.error?.detail || "",
  });
}

async function boot(): Promise<void> {
  let state = initialBoot();
  pushBoot(state, "starting");

  // The probe is bounded and best-effort; the fallback PATH covers a failure.
  const probed = await probeLoginEnv();
  const env = withFallbackPath(mergeEnv(process.env as Env, probed), homeDir());
  // Names only, never values: this string reaches a window, and the
  // environment carries ANTHROPIC_AUTH_TOKEN and friends.
  pushBoot(state, "ready", probed ? "from your shell" : "using known locations");

  await startServers(
    env,
    (ev) => {
      state = applyBootEvent(state, ev);
      pushBoot(state, "ready", probed ? "from your shell" : "using known locations");
    },
    ports,
  );

  if (bootPhase(state) !== "ready") return; // the boot window shows why

  mainWindow = createWindow();
  await mainWindow.loadURL(FRONTEND_URL);
  mainWindow.show();
  if (bootWindow && !bootWindow.isDestroyed()) bootWindow.close();
  bootWindow = null;
}

/** The whole retry cycle: drain the old children, then boot from scratch.
 *  `booting` is set for its full duration -- not just boot()'s share of it
 *  -- because a click landing during the ~3.5s stopServers() drain is just
 *  as capable of starting an overlapping cycle as one landing during boot()
 *  itself. */
async function restart(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    await stopServers();
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
  bootWindow = createBootWindow();
  // Wait for the page before pushing state, or the first push lands nowhere.
  await new Promise<void>((resolve) =>
    bootWindow!.webContents.once("did-finish-load", () => resolve()),
  );
  // An unhandled rejection here is a boot that stops silently -- the one
  // thing this window exists to prevent -- so it is logged rather than left
  // to vanish into whatever process.on("unhandledRejection") does by default.
  // Only ever the message of our own thrown error, never anything reached
  // via a probe or a spawned child's environment.
  await boot().catch((err) => {
    console.error("[yuri] boot() rejected:", err instanceof Error ? err.message : err);
  });

  ipcMain.on("boot:retry", () => {
    void restart().catch((err) => {
      console.error("[yuri] restart() rejected:", err instanceof Error ? err.message : err);
    });
  });
  // No flag here: before-quit is the only place quitting is set. Setting it
  // at this call site used to make before-quit's own re-entry guard skip the
  // drain, so the app exited via the default window-all-closed path with
  // both children still holding their ports.
  ipcMain.on("boot:quit", () => {
    app.quit();
  });

  globalShortcut.register("CommandOrControl+Shift+Y", () => showMainWindow());
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
  void stopServers().finally(() => app.exit(0));
});

// macOS: clicking the Dock icon after a hide must bring her back.
app.on("activate", () => showMainWindow());

app.on("will-quit", () => globalShortcut.unregisterAll());
