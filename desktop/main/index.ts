// Yuri OS desktop shell: the main process.
//
// Deliberately thin. Every decision that can be wrong in a way nobody
// notices -- which environment the children get, whether the boot is ready
// or failed, which tray state a set of facts means -- lives in ../lib as a
// pure function with tests, because there is no Electron test environment.
import { app, BrowserWindow, shell } from "electron";
import * as path from "node:path";
import { applyBootEvent, bootPhase, initialBoot } from "../lib/boot";
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

  return win;
}

app.whenReady().then(async () => {
  // The probe is bounded and best-effort; the fallback PATH covers a failure.
  const probed = await probeLoginEnv();
  const env = withFallbackPath(mergeEnv(process.env as Env, probed), homeDir());

  let boot = initialBoot();
  mainWindow = createWindow();

  await startServers(env, (ev) => {
    boot = applyBootEvent(boot, ev);
  }, ports);

  if (bootPhase(boot) !== "ready") {
    // Task 4 replaces this with the boot window's failure state. Until then,
    // failing loudly beats a blank window. Never log `env`: it carries
    // ANTHROPIC_AUTH_TOKEN and friends.
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
