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
