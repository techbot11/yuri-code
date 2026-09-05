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
