import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } from "electron";
import { getToolSetupStatus } from "../src/toolCheck.js";
import { PIPELINE_ERROR } from "../src/pipelineErrors.js";
import { createProgressModel, describeProgress } from "../src/progress.js";
import { readUserConfig, writeUserConfigSection } from "../src/userConfig.js";
import { initLogFile, logRecord, getLogPath } from "./logFile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

/**
 * Bundled tools live in extraResources → resources/vendor (see electron-builder.yml).
 * Also check vendor next to the .exe for unusual layouts / portable copies.
 */
let cachedVendorBaseDir = null;

function vendorBaseDir() {
  if (cachedVendorBaseDir) {
    return cachedVendorBaseDir;
  }
  if (!app.isPackaged) {
    cachedVendorBaseDir = path.join(projectRoot, "vendor");
    return cachedVendorBaseDir;
  }
  const win = process.platform === "win32";
  const marker = win ? "yt-dlp.exe" : "yt-dlp";
  const exeDir = path.dirname(process.execPath);
  const resourcesPath = process.resourcesPath || path.join(exeDir, "resources");
  const candidates = [path.join(resourcesPath, "vendor"), path.join(exeDir, "vendor")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, marker))) {
      cachedVendorBaseDir = dir;
      return cachedVendorBaseDir;
    }
  }
  cachedVendorBaseDir = candidates[0];
  return cachedVendorBaseDir;
}

function bundledToolPaths() {
  const base = vendorBaseDir();
  const win = process.platform === "win32";
  return {
    ytdlp: path.join(base, win ? "yt-dlp.exe" : "yt-dlp"),
    ffmpeg: path.join(base, win ? "ffmpeg.exe" : "ffmpeg")
  };
}

/** Set env to bundled tools. Cheap enough to call per IPC: two existsSync on a cached dir. */
function applyBundledToolEnv() {
  const { ytdlp, ffmpeg } = bundledToolPaths();
  if (fs.existsSync(ytdlp)) {
    process.env.YOUTUBE_DJ_YTDLP = ytdlp;
  }
  if (fs.existsSync(ffmpeg)) {
    process.env.YOUTUBE_DJ_FFMPEG = ffmpeg;
  }
}

/** chmod vendor binaries. Runs once after the window is up, never on the IPC hot path. */
async function applyBundledToolPermissions() {
  const { ytdlp, ffmpeg } = bundledToolPaths();
  await Promise.all(
    [ytdlp, ffmpeg].map(async (p) => {
      try {
        await fs.promises.chmod(p, 0o755);
      } catch {
        /* missing or not ours to chmod */
      }
    })
  );
}

let mainWindow = null;

async function createWindow() {
  applyBundledToolEnv();
  mainWindow = new BrowserWindow({
    width: 800,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    show: false,
    backgroundColor: "#121218",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // An occluded window otherwise throttles rAF to ~1/min, which stalls the
      // renderer's log flush and setup check while a long run is in progress.
      backgroundThrottling: false
    }
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  applyBundledToolPermissions();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initLogFile();
    logRecord({ event: "app.ready", version: app.getVersion(), platform: process.platform });
    return createWindow();
  });
}

// A freeze or crash should leave evidence rather than just vanishing.
app.on("render-process-gone", (_e, _wc, details) => {
  logRecord({ event: "render-process-gone", ...details });
});

app.on("child-process-gone", (_e, details) => {
  logRecord({ event: "child-process-gone", ...details });
});

process.on("uncaughtException", (err) => {
  logRecord({ event: "uncaughtException", message: err?.message, stack: err?.stack });
});

app.on("before-quit", () => {
  logRecord({ event: "app.before-quit" });
  pipelineChild?.postMessage({ type: "cancel" });
  pipelineChild?.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Synchronous by necessity: preload needs the enum before the renderer script runs.
// It is a frozen literal, so there is no I/O behind this.
ipcMain.on("app:getErrorCodes", (event) => {
  event.returnValue = PIPELINE_ERROR;
});

ipcMain.handle("dialog:pickOutputDir", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"]
  });
  if (r.canceled || !r.filePaths[0]) {
    return null;
  }
  return r.filePaths[0];
});

/**
 * Folders and files need separate dialogs: macOS can offer both at once, Windows
 * cannot, and two buttons read more clearly than one that behaves differently per
 * platform.
 */
ipcMain.handle("dialog:pickLocalSource", async (_e, kind) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const r = await dialog.showOpenDialog(win, {
    properties: [kind === "file" ? "openFile" : "openDirectory"],
    ...(kind === "file"
      ? { filters: [{ name: "Audio", extensions: ["mp3", "flac", "wav", "aiff", "aif", "m4a", "aac"] }] }
      : {})
  });
  if (r.canceled || !r.filePaths[0]) {
    return null;
  }
  return r.filePaths[0];
});

ipcMain.handle("shell:openPath", async (_e, p) => {
  if (typeof p !== "string") {
    return;
  }
  await shell.openPath(p);
});

/**
 * The product is now called DJ Pipeline, but anyone who has already run it has
 * tracks in the old folder. Where that exists it stays the default, so the rename
 * cannot orphan an existing library.
 */
ipcMain.handle("app:getDefaultOutputDir", () => {
  const documents = app.getPath("documents");
  const previous = path.join(documents, "YouTube DJ Pipeline output");
  if (fs.existsSync(previous)) {
    return previous;
  }
  return path.join(documents, "DJ Pipeline output");
});

/** The key is never handed to the renderer; only whether one is saved. */
ipcMain.handle("config:getAiSettings", () => {
  const ai = readUserConfig().ai ?? {};
  return {
    hasApiKey: Boolean(String(ai.apiKey ?? "").trim()),
    model: String(ai.model ?? ""),
    baseUrl: String(ai.baseUrl ?? ""),
    // A key in the environment wins over the file, so the UI has to say so rather
    // than show an empty field next to advice that is demonstrably working.
    fromEnvironment: Boolean(process.env.YOUTUBE_DJ_AI_API_KEY || process.env.OPENAI_API_KEY)
  };
});

ipcMain.handle("config:setAiSettings", (_e, { apiKey, model } = {}) => {
  try {
    // An omitted field leaves the stored value alone; an empty one clears it.
    // That distinction is what lets the UI show a masked placeholder for a saved
    // key without having to hand the key back to the renderer to resave it.
    writeUserConfigSection("ai", {
      ...(apiKey === undefined ? {} : { apiKey: String(apiKey) }),
      ...(model === undefined ? {} : { model: String(model) })
    });
    return { ok: true };
  } catch (err) {
    logRecord({ event: "config.write.failed", message: err?.message });
    return { ok: false, error: String(err?.message ?? err) };
  }
});

ipcMain.handle("app:checkSetup", async () => {
  applyBundledToolEnv();
  return getToolSetupStatus();
});

/**
 * The pipeline runs in a utilityProcess. Nothing it does — NodeID3's whole-file
 * rewrite, JSON.parse of a large playlist dump, XML writes — can reach this process,
 * so the window stays responsive regardless of what the run is doing.
 */
let pipelineChild = null;
/** Monotonic: a message from a superseded run must not resolve the current one. */
let lastRunId = 0;
/** @type {{ runId: number, resolve: (r: unknown) => void, webContents: Electron.WebContents } | null} */
let activeRun = null;

function forkPipelineChild() {
  const child = utilityProcess.fork(path.join(__dirname, "pipelineHost.js"), [], {
    serviceName: "youtube-dj-pipeline",
    stdio: "pipe",
    env: { ...process.env }
  });

  // 'pipe' streams must be drained or the child blocks once the buffer fills.
  child.stdout?.on("data", (c) => logRecord({ event: "child.stdout", text: String(c).trim() }));
  child.stderr?.on("data", (c) => logRecord({ event: "child.stderr", text: String(c).trim() }));

  child.on("message", (message) => handleChildMessage(message));

  child.on("exit", (code) => {
    logRecord({ event: "child.exit", code });
    pipelineChild = null;
    if (activeRun) {
      finishRun(activeRun.runId, {
        ok: false,
        error: `The pipeline process stopped unexpectedly (exit ${code}). See ${getLogPath() ?? "the log"}.`,
        code: PIPELINE_ERROR.UNKNOWN,
        outputRoot: activeRun.outputRoot
      });
    }
  });

  return child;
}

function ensurePipelineChild() {
  if (!pipelineChild) {
    pipelineChild = forkPipelineChild();
  }
  return pipelineChild;
}

function finishRun(runId, result) {
  if (!activeRun || activeRun.runId !== runId) return;
  const { resolve } = activeRun;
  activeRun = null;
  resolve(result);
}

/**
 * Phase counters become one fraction here rather than in the renderer, so the
 * desktop app and the CLI cannot disagree about how far along a run is.
 */
function decorateProgress(progress) {
  const { fraction, indeterminate } = activeRun.progressModel.update(progress);
  return {
    ...progress,
    fraction,
    indeterminate,
    label: describeProgress(progress)
  };
}

function handleChildMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "diag") {
    logRecord({ event: "pipeline", ...message.record });
    return;
  }
  // Drop anything from a run the UI has already moved on from.
  if (!activeRun || message.runId !== activeRun.runId) return;

  const target = activeRun.webContents;
  if (message.type === "log") {
    if (!target.isDestroyed()) target.send("pipeline:log", message.line);
    return;
  }
  if (message.type === "progress") {
    if (!target.isDestroyed()) target.send("pipeline:progress", decorateProgress(message.progress));
    return;
  }
  if (message.type === "done") {
    finishRun(message.runId, message.result);
  }
}

ipcMain.handle("pipeline:cancel", () => {
  pipelineChild?.postMessage({ type: "cancel" });
  return true;
});

ipcMain.handle(
  "pipeline:start",
  async (
    event,
    { mode, playlistUrl, inputPath, outputRoot, audioFormat, proxy, analyze, includeBeatgrid, setOrder }
  ) => {
    let root;
    try {
      root = path.resolve(String(outputRoot || "").trim() || ".");
    } catch {
      root = path.resolve(".");
    }

    if (activeRun) {
      return {
        ok: false,
        error: "A run is already in progress. Stop it before starting another.",
        code: PIPELINE_ERROR.UNKNOWN,
        outputRoot: root
      };
    }

    applyBundledToolEnv();
    const runId = ++lastRunId;
    const child = ensurePipelineChild();
    const local = mode === "local";
    // Analysis is the entire job in local mode, so it is not something to switch off.
    const willAnalyze = local || Boolean(analyze);

    return new Promise((resolve) => {
      activeRun = {
        runId,
        resolve,
        webContents: event.sender,
        outputRoot: root,
        progressModel: createProgressModel({
          source: local ? "local" : "url",
          analyze: willAnalyze,
          setOrder: Boolean(setOrder)
        })
      };
      logRecord({
        event: "run.start",
        runId,
        mode: local ? "local" : "url",
        audioFormat,
        analyze: willAnalyze,
        // Never the value: a proxy URL can carry credentials and this log is shareable.
        proxy: proxy ? "set" : "none"
      });
      child.postMessage({
        type: "start",
        runId,
        mode: local ? "local" : "url",
        playlistUrl,
        inputPath: typeof inputPath === "string" ? inputPath : "",
        outputRoot: root,
        audioFormat,
        proxy: typeof proxy === "string" ? proxy.trim() : "",
        analyze: willAnalyze,
        includeBeatgrid: Boolean(includeBeatgrid),
        setOrder: Boolean(setOrder)
      });
    });
  }
);
