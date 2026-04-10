import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { runPlaylist, normalizePlaylistUrl, assertValidYouTubePlaylistUrl } from "../src/pipeline.js";
import { getToolSetupStatus } from "../src/toolCheck.js";
import { toPipelineError, PIPELINE_ERROR } from "../src/pipelineErrors.js";
import { killAllPipelineChildren } from "../src/pipelineChildren.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

/**
 * Bundled tools live in extraResources → resources/vendor (see electron-builder.yml).
 * Also check vendor next to the .exe for unusual layouts / portable copies.
 */
function vendorBaseDir() {
  if (!app.isPackaged) {
    return path.join(projectRoot, "vendor");
  }
  const win = process.platform === "win32";
  const marker = win ? "yt-dlp.exe" : "yt-dlp";
  const exeDir = path.dirname(process.execPath);
  const resourcesPath = process.resourcesPath || path.join(exeDir, "resources");
  const candidates = [path.join(resourcesPath, "vendor"), path.join(exeDir, "vendor")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, marker))) {
      return dir;
    }
  }
  return candidates[0];
}

/** Set env to bundled tools (fast; no disk chmod). */
function applyBundledToolEnv() {
  const base = vendorBaseDir();
  const win = process.platform === "win32";
  const ytdlp = path.join(base, win ? "yt-dlp.exe" : "yt-dlp");
  const ff = path.join(base, win ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(ytdlp)) {
    process.env.YOUTUBE_DJ_YTDLP = ytdlp;
  }
  if (fs.existsSync(ff)) {
    process.env.YOUTUBE_DJ_FFMPEG = ff;
  }
}

/** chmod vendor binaries (can run after first paint). */
function applyBundledToolPermissions() {
  const base = vendorBaseDir();
  const win = process.platform === "win32";
  const ytdlp = path.join(base, win ? "yt-dlp.exe" : "yt-dlp");
  const ff = path.join(base, win ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(ytdlp)) {
    try {
      fs.chmodSync(ytdlp, 0o755);
    } catch {
      /* ignore */
    }
  }
  if (fs.existsSync(ff)) {
    try {
      fs.chmodSync(ff, 0o755);
    } catch {
      /* ignore */
    }
  }
}

/** Prefer bundled yt-dlp/ffmpeg in vendor/ when present (packaged app or after fetch-tools). */
function applyBundledToolPaths() {
  applyBundledToolEnv();
  applyBundledToolPermissions();
}

let mainWindow = null;
let abortController = null;

async function createWindow() {
  applyBundledToolPaths();
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
      nodeIntegration: false
    }
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => createWindow());

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

ipcMain.handle("shell:openPath", async (_e, p) => {
  if (typeof p !== "string") {
    return;
  }
  await shell.openPath(p);
});

ipcMain.handle("app:getDefaultOutputDir", () =>
  path.join(app.getPath("documents"), "YouTube DJ Pipeline output")
);

ipcMain.handle("app:checkSetup", async () => {
  applyBundledToolPaths();
  return getToolSetupStatus();
});

ipcMain.handle("pipeline:cancel", () => {
  killAllPipelineChildren();
  abortController?.abort();
  return true;
});

ipcMain.handle("pipeline:start", async (event, { playlistUrl, outputRoot }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const sendLog = (line) => win?.webContents?.send("pipeline:log", line);
  const sendProg = (p) => win?.webContents?.send("pipeline:progress", p);

  abortController = new AbortController();
  applyBundledToolPaths();

  let root;
  try {
    root = path.resolve(String(outputRoot || "").trim() || ".");
  } catch {
    root = path.resolve(".");
  }

  try {
    const normalized = normalizePlaylistUrl(playlistUrl);
    assertValidYouTubePlaylistUrl(normalized);
    const summary = await runPlaylist({
      playlistUrl: normalized,
      outputRoot: root,
      signal: abortController.signal,
      onLog: sendLog,
      onProgress: sendProg
    });
    return {
      ok: true,
      outputRoot: root,
      failures: summary.failures,
      csvPath: summary.csvPath,
      xmlPath: summary.xmlPath,
      successCount: summary.successCount,
      totalCount: summary.totalCount
    };
  } catch (e) {
    const { code, message } = toPipelineError(e);
    return {
      ok: false,
      error: message,
      code,
      cancelled: code === PIPELINE_ERROR.CANCELLED,
      outputRoot: root
    };
  }
});
