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
// The ONLY thing that lets a close event through to actually destroy a
// window. Without it, the close handler below would also swallow ⌘Q --
// see the before-quit handler at the bottom of this file.
let quitting = false;

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
  // Electron's 'minimize' fires AFTER the OS already minimized the window --
  // it is not cancelable (no event.preventDefault() here, unlike 'close') --
  // so this hides it right back rather than leaving it sitting minimized in
  // the Dock, which would be a second, inconsistent "closed" state.
  win.on("minimize", () => win.hide());

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
  void win.loadFile(path.join(__dirname, "../boot/index.html"));
  return win;
}

/** Push the current boot state to the boot window. `env`/`envDetail` cover
 *  the shell-probe row, which is not part of BootState (it finishes before
 *  startServers begins and never fails outright, only falls back). */
function pushBoot(state: BootState, env: ChildState, envDetail = ""): void {
  bootWindow?.webContents.send("boot:state", {
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
  bootWindow?.close();
  bootWindow = null;
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
