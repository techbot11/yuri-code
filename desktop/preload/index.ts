// The only bridge between a renderer and the main process. Two channels, both
// one-directional by design: the boot page receives state and can ask to
// retry or quit; the app reports its tray state. Nothing else is exposed.
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
    ipcRenderer.invoke("boot:current").then((s) => { if (s && !live) cb(s); });
  },
  retry: () => ipcRenderer.send("boot:retry"),
  quit: () => ipcRenderer.send("boot:quit"),
});

contextBridge.exposeInMainWorld("yuriTray", {
  set: (state: string) => ipcRenderer.send("tray:state", state),
});
