// The tray: Yuri's presence while her window is hidden.
//
// Its own module for the same reason servers.ts and shellEnv.ts are: this
// file is only the Electron plumbing. The vocabulary it renders (the states
// and their labels) is pure and lives in ../lib/tray.ts; the decision of
// WHICH state to show is not made in this process at all -- the renderer
// makes it in frontend/lib/trayState.ts and sends the answer over
// tray:state, which setTrayState() below validates. Keeping it out of
// index.ts also means currentTrayState()/trayMenuTemplate() are honest
// accessors -- part of this module's real API -- rather than `_forVerification`
// exports bolted onto the app's entry point.
import { app, Menu, nativeImage, Tray } from "electron";
import * as path from "node:path";
import { TRAY_STATES, trayLabel, type TrayState } from "../lib/tray";

let tray: Tray | null = null;
let current: TrayState = "asleep";
// Bound once, at createTray() time, and reused on every refresh -- the menu
// is rebuilt on every state change, but "Show Yuri" always means the same
// thing for the tray's whole lifetime.
let onShow: (() => void) | null = null;
// Kept alongside `tray` for the same reason `tray` itself is exported via an
// accessor: this Electron version's Tray has no getContextMenu() to read
// back what was set, so the template built on the last refresh is the only
// thing a caller (test or otherwise) can inspect.
let lastMenuTemplate: Electron.MenuItemConstructorOptions[] = [];

function isTrayState(s: string): s is TrayState {
  return (TRAY_STATES as readonly string[]).includes(s);
}

/** What the tray is currently showing. */
export function currentTrayState(): TrayState {
  return current;
}

/** The menu template as last built, so a caller can assert what the user
 *  would see without a live getContextMenu() to read it back from. */
export function trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return lastMenuTemplate;
}

/** Whether the tray icon exists yet. */
export function hasTray(): boolean {
  return tray !== null;
}

function iconFor(state: TrayState): Electron.NativeImage {
  const img = nativeImage.createFromPath(
    path.join(__dirname, `../assets/${state}Template@2x.png`));
  // Marking it a template is what makes macOS tint it for the menu bar's
  // light and dark appearance; an untinted icon is invisible in one of them.
  img.setTemplateImage(true);
  return img;
}

function refreshTray(): void {
  if (!tray || !onShow) return;
  tray.setImage(iconFor(current));
  tray.setToolTip(`Yuri — ${trayLabel(current)}`);
  lastMenuTemplate = [
    { label: trayLabel(current), enabled: false },
    { type: "separator" },
    { label: "Show Yuri", click: () => onShow!() },
    // Just app.quit(). Setting the app's own `quitting` flag here would make
    // before-quit's own re-entry guard skip the drain and orphan both
    // children holding their ports -- measured, from the boot page's Quit
    // button doing exactly that.
    { label: "Quit Yuri", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(lastMenuTemplate));
}

/** Create the tray icon. `show` is what "Show Yuri" (menu item and left
 *  click) calls -- injected rather than imported, so this module does not
 *  need to know about mainWindow or index.ts at all. */
export function createTray(show: () => void): void {
  onShow = show;
  tray = new Tray(iconFor("asleep"));
  // A left click shows her, which is what a tray icon should do; the menu is
  // on right-click, per the platform.
  tray.on("click", () => show());
  refreshTray();
}

/** Apply a state the renderer reported over IPC. Rejects anything not in
 *  TRAY_STATES: an unknown string would reach setImage and blank the icon.
 *
 *  The rejection is LOGGED, not silent. The rule that picks a state lives in
 *  frontend/lib/trayState.ts, whose TrayState union is an independent
 *  declaration in a separately compiled process -- there is no compile-time
 *  link to ../lib/tray.ts's union and no test can make one (see that file).
 *  So this log is the only thing standing between "a state was added to the
 *  frontend and not to TRAY_STATES" and a tray that just keeps showing the
 *  previous icon forever with nothing anywhere saying why. */
export function setTrayState(state: string): void {
  if (!isTrayState(state)) {
    // The rejected slug only, bounded: this is a value the renderer chose
    // from a fixed vocabulary, never environment or conversation content.
    console.error("[yuri] tray: ignoring a state that is not in TRAY_STATES: " +
      JSON.stringify(String(state).slice(0, 40)) +
      " — add it to desktop/lib/tray.ts (and give it an icon) or stop sending it");
    return;
  }
  if (state === current) return; // avoid rebuilding the menu on every poll
  current = state;
  refreshTray();
}
