// The only bridge between a renderer and the main process. Channels are
// one-directional by design: the boot page receives state and can ask to
// retry, quit, or re-read/open the microphone permission; the app reports
// its tray state. Nothing else is exposed.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yuriBoot", {
  /** Subscribe to boot state, INCLUDING what already happened.
   *
   *  The subscription alone is not enough: the environment resolves and both
   *  children spawn before this renderer's JS runs, so a plain listener
   *  hears nothing about a boot that is already well underway. So it also
   *  asks main for the last payload -- and drops that answer if a live push
   *  has landed meanwhile, since replaying older state over newer would
   *  march the UI backwards. */
  onState: (cb: (s: unknown) => void) => {
    let live = false;
    ipcRenderer.on("boot:state", (_e, s) => { live = true; cb(s); });
    // The .catch is not decoration: invoke() rejects if no handler is
    // registered on the other side, and without it that becomes an
    // unhandled rejection in the renderer. The live subscription above is
    // the primary channel, so a failed replay degrades to "no news" -- but
    // it says so, because a replay that silently never arrives looks exactly
    // like a boot that never made progress.
    ipcRenderer.invoke("boot:current")
      .then((s) => { if (s && !live) cb(s); })
      .catch((err: unknown) => {
        console.warn("[yuri] boot:current replay unavailable:",
                     err instanceof Error ? err.message : err);
      });
  },
  retry: () => ipcRenderer.send("boot:retry"),
  quit: () => ipcRenderer.send("boot:quit"),
  micStatus: () => ipcRenderer.invoke("mic:status"),
  openMicSettings: () => ipcRenderer.send("mic:settings"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
});

contextBridge.exposeInMainWorld("yuriTray", {
  set: (state: string) => ipcRenderer.send("tray:state", state),
});

// Secrets go renderer -> IPC -> main -> safeStorage, never over HTTP -- not
// even on loopback (spec 6.3). Only present in the desktop shell: a plain
// browser tab has no bridge at all, and SetupPanel falls back to
// PUT /yuri/config for secrets there, exactly as it always has.
contextBridge.exposeInMainWorld("yuriCredentials", {
  write: (updates: Record<string, string>) =>
    ipcRenderer.invoke("credentials:write", updates),
  names: () => ipcRenderer.invoke("credentials:names"),
});
