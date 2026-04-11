const $ = (id) => document.getElementById(id);

const playlistInput = $("playlistUrl");
const outputInput = $("outputDir");
const browseBtn = $("browseBtn");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const openBtn = $("openBtn");
const logEl = $("log");
const progressEl = $("progress");
const failuresSection = $("failuresSection");
const failuresList = $("failuresList");
const failuresCsvNote = $("failuresCsvNote");
const setupBanner = $("setupBanner");
const setupBannerText = $("setupBannerText");
const recheckSetupBtn = $("recheckSetupBtn");

const ERROR_CODE = {
  INVALID_URL: "INVALID_URL",
  TOOLS_UNAVAILABLE: "TOOLS_UNAVAILABLE",
  PLAYLIST_FETCH: "PLAYLIST_FETCH",
  VIDEO_METADATA: "VIDEO_METADATA",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN"
};

const MAX_LOG_LINES = 2000;

let lastOutputRoot = null;
let unsubLog = null;
let unsubProgress = null;
let setupReady = false;
let pipelineRunning = false;

function clearLog() {
  logEl.replaceChildren();
}

function appendLog(line) {
  const row = document.createElement("div");
  row.className = "log-line";
  row.textContent = line;
  logEl.appendChild(row);
  while (logEl.children.length > MAX_LOG_LINES) {
    logEl.removeChild(logEl.firstChild);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function syncStartDisabled() {
  startBtn.disabled = pipelineRunning || !setupReady;
}

function setRunning(running) {
  pipelineRunning = running;
  syncStartDisabled();
  stopBtn.disabled = !running;
  browseBtn.disabled = running;
  playlistInput.disabled = running;
}

function clearFailuresUi() {
  failuresSection.classList.add("hidden");
  failuresList.textContent = "";
  failuresCsvNote.textContent = "";
}

function showFailuresUi(failures, csvPath) {
  if (!failures?.length) {
    clearFailuresUi();
    return;
  }
  failuresSection.classList.remove("hidden");
  failuresCsvNote.textContent = csvPath
    ? `Details saved to CSV: ${csvPath}`
    : "";
  failuresList.textContent = "";
  for (const f of failures) {
    const li = document.createElement("li");
    const title = (f.title || "").trim() || "(unknown title)";
    const strong = document.createElement("strong");
    strong.textContent = title;
    li.appendChild(strong);
    li.appendChild(document.createElement("br"));
    const urlSpan = document.createElement("span");
    urlSpan.className = "fail-url";
    urlSpan.textContent = f.url || "";
    li.appendChild(urlSpan);
    li.appendChild(document.createElement("br"));
    li.appendChild(document.createTextNode(f.reason || ""));
    failuresList.appendChild(li);
  }
}

function formatSetupIssues(status) {
  const parts = [];
  if (!status.ytDlp?.ok && status.ytDlp?.error) {
    parts.push(status.ytDlp.error);
  }
  if (!status.ffmpeg?.ok && status.ffmpeg?.error) {
    parts.push(status.ffmpeg.error);
  }
  return parts.join("\n\n") || "yt-dlp or ffmpeg could not be verified.";
}

async function refreshSetup() {
  try {
    const status = await window.ytDj.checkSetup();
    setupReady = !!status?.ok;
    if (setupReady) {
      setupBanner.classList.add("hidden");
      setupBannerText.textContent = "";
    } else {
      setupBanner.classList.remove("hidden");
      setupBannerText.textContent = formatSetupIssues(status);
    }
  } catch (e) {
    setupReady = false;
    setupBanner.classList.remove("hidden");
    setupBannerText.textContent = String(e?.message || e || "Could not check tools.");
  }
  syncStartDisabled();
}

function logPipelineFailure(result) {
  if (result.cancelled || result.code === ERROR_CODE.CANCELLED) {
    appendLog("Stopped.");
    return;
  }
  if (result.code === ERROR_CODE.TOOLS_UNAVAILABLE) {
    appendLog("yt-dlp or ffmpeg is not available. Fix the setup (see the notice above), then click Check again.");
    if (result.error) {
      appendLog(result.error);
    }
    return;
  }
  if (result.code === ERROR_CODE.INVALID_URL) {
    appendLog(result.error || "Invalid URL (use YouTube or SoundCloud).");
    return;
  }
  if (result.code === ERROR_CODE.PLAYLIST_FETCH) {
    appendLog(result.error || "Could not load the playlist.");
    return;
  }
  if (result.code === ERROR_CODE.VIDEO_METADATA) {
    appendLog(result.error || "Could not read video metadata.");
    return;
  }
  appendLog(result.error || "Failed.");
}

async function initDefaults() {
  try {
    const def = await window.ytDj.getDefaultOutputDir();
    outputInput.value = def;
  } catch {
    outputInput.value = "";
  }
}

browseBtn.addEventListener("click", async () => {
  const picked = await window.ytDj.pickOutputDir();
  if (picked) {
    outputInput.value = picked;
  }
});

recheckSetupBtn.addEventListener("click", () => {
  refreshSetup();
});

window.addEventListener("focus", () => {
  if (!pipelineRunning) {
    refreshSetup();
  }
});

stopBtn.addEventListener("click", async () => {
  await window.ytDj.cancel();
});

openBtn.addEventListener("click", async () => {
  const p = lastOutputRoot || outputInput.value.trim();
  if (p) {
    await window.ytDj.openPath(p);
  }
});

startBtn.addEventListener("click", async () => {
  const playlistUrl = playlistInput.value.trim();
  const outputRoot = outputInput.value.trim();
  if (!playlistUrl) {
    appendLog("Enter a playlist or track URL.");
    return;
  }
  if (!outputRoot) {
    appendLog("Choose an output folder.");
    return;
  }

  clearLog();
  progressEl.textContent = "";
  clearFailuresUi();
  openBtn.disabled = true;
  lastOutputRoot = null;

  unsubLog?.();
  unsubProgress?.();
  unsubLog = window.ytDj.onLog(appendLog);
  unsubProgress = window.ytDj.onProgress((p) => {
    progressEl.textContent = `Track ${p.current} / ${p.total}: ${p.title || ""}`;
  });

  setRunning(true);
  let result;
  try {
    result = await window.ytDj.start({ playlistUrl, outputRoot });
    if (!result.ok) {
      logPipelineFailure(result);
      if (result.code === ERROR_CODE.TOOLS_UNAVAILABLE) {
        await refreshSetup();
      }
    } else if (result.failures?.length) {
      showFailuresUi(result.failures, result.csvPath);
      const saved = result.successCount ?? 0;
      const failed = result.failures.length;
      appendLog(`Done: ${saved} saved, ${failed} failed.`);
    } else if ((result.totalCount ?? 0) === 0) {
      appendLog("Done: playlist had no items.");
    } else {
      appendLog("Done: all tracks completed successfully.");
    }
  } catch (e) {
    appendLog(String(e?.message || e));
  } finally {
    lastOutputRoot = result?.outputRoot ?? outputRoot;
    openBtn.disabled = !lastOutputRoot;
    setRunning(false);
    unsubLog?.();
    unsubProgress?.();
    unsubLog = null;
    unsubProgress = null;
  }
});

(async () => {
  await initDefaults();
  // Defer setup IPC until after first paint so the window does not feel frozen on launch.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshSetup();
    });
  });
})();
