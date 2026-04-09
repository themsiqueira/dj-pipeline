const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ytDj", {
  pickOutputDir: () => ipcRenderer.invoke("dialog:pickOutputDir"),
  getDefaultOutputDir: () => ipcRenderer.invoke("app:getDefaultOutputDir"),
  checkSetup: () => ipcRenderer.invoke("app:checkSetup"),
  start: (opts) => ipcRenderer.invoke("pipeline:start", opts),
  cancel: () => ipcRenderer.invoke("pipeline:cancel"),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),
  onLog: (cb) => {
    const fn = (_e, line) => cb(line);
    ipcRenderer.on("pipeline:log", fn);
    return () => ipcRenderer.removeListener("pipeline:log", fn);
  },
  onProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on("pipeline:progress", fn);
    return () => ipcRenderer.removeListener("pipeline:progress", fn);
  }
});
