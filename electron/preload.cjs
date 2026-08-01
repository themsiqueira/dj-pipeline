const { contextBridge, ipcRenderer } = require("electron");

// Mirrored from src/pipelineErrors.js at load time; the renderer cannot import from src/.
const errorCodes = ipcRenderer.sendSync("app:getErrorCodes");

contextBridge.exposeInMainWorld("ytDj", {
  errorCodes,
  pickOutputDir: () => ipcRenderer.invoke("dialog:pickOutputDir"),
  pickLocalSource: (kind) => ipcRenderer.invoke("dialog:pickLocalSource", kind),
  getDefaultOutputDir: () => ipcRenderer.invoke("app:getDefaultOutputDir"),
  getAiSettings: () => ipcRenderer.invoke("config:getAiSettings"),
  setAiSettings: (settings) => ipcRenderer.invoke("config:setAiSettings", settings),
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
