const $ = (id) => document.getElementById(id);

const backBtn = $("backBtn");
const appSubtitle = $("appSubtitle");
const homeScreen = $("homeScreen");
const taskScreen = $("taskScreen");
const settingsScreen = $("settingsScreen");
const taskHeading = $("taskHeading");
const taskLead = $("taskLead");
const downloadFields = $("downloadFields");
const localFields = $("localFields");

const playlistInput = $("playlistUrl");
const audioFormatSelect = $("audioFormat");
const sourcePathInput = $("sourcePath");
const pickFolderBtn = $("pickFolderBtn");
const pickFileBtn = $("pickFileBtn");
const proxyInput = $("proxy");
const analyzeCheckbox = $("analyze");
const analyzeHint = $("analyzeHint");
const beatgridCheckbox = $("includeBeatgrid");
const setOrderCheckbox = $("setOrder");
const outputInput = $("outputDir");
const browseBtn = $("browseBtn");
const aiApiKeyInput = $("aiApiKey");
const aiModelInput = $("aiModel");
const settingsDoneBtn = $("settingsDoneBtn");
const settingsStatus = $("settingsStatus");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const openBtn = $("openBtn");
const logEl = $("log");
const logDetails = $("logDetails");
const progressEl = $("progress");
const progressBar = $("progressBar");
const progressFill = $("progressFill");
const failuresSection = $("failuresSection");
const failuresList = $("failuresList");
const failuresCsvNote = $("failuresCsvNote");
const setupBanner = $("setupBanner");
const setupBannerText = $("setupBannerText");
const recheckSetupBtn = $("recheckSetupBtn");

const ERROR_CODE = window.ytDj.errorCodes;

const MAX_LOG_LINES = 2000;
const AUDIO_FORMAT_STORAGE_KEY = "ytDj.audioFormat";
const PROXY_STORAGE_KEY = "ytDj.proxy";
const ANALYZE_STORAGE_KEY = "ytDj.analyze";
const BEATGRID_STORAGE_KEY = "ytDj.includeBeatgrid";
const SET_ORDER_STORAGE_KEY = "ytDj.setOrder";
const OUTPUT_DIR_STORAGE_KEY = "ytDj.outputDir";
const SOURCE_PATH_STORAGE_KEY = "ytDj.sourcePath";
const SCREEN_STORAGE_KEY = "ytDj.screen";

const SCREEN = { HOME: "home", DOWNLOAD: "download", LOCAL: "local", SETTINGS: "settings" };

const TASK_COPY = {
  [SCREEN.DOWNLOAD]: {
    heading: "Download tracks",
    lead: "Paste a playlist, set, or single-track URL. Tracks are downloaded, loudness-matched and tagged."
  },
  [SCREEN.LOCAL]: {
    heading: "Analyze my library",
    lead: "Choose a folder or a single track you already own. Your files are read and tagged where they are."
  }
};

let currentScreen = SCREEN.HOME;
let lastOutputRoot = null;
let unsubLog = null;
let unsubProgress = null;
let setupReady = false;
let pipelineRunning = false;

/** Pixels of slack before we consider the user to have scrolled away from the tail. */
const AUTOSCROLL_THRESHOLD_PX = 24;

let pendingLines = [];
let flushHandle = null;

function isPinnedToBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < AUTOSCROLL_THRESHOLD_PX;
}

function flushLog() {
  flushHandle = null;
  if (pendingLines.length === 0) return;

  const pinned = isPinnedToBottom();
  const fragment = document.createDocumentFragment();
  for (const line of pendingLines) {
    const row = document.createElement("div");
    row.className = "log-line";
    row.textContent = line;
    fragment.appendChild(row);
  }
  pendingLines = [];
  logEl.appendChild(fragment);

  while (logEl.children.length > MAX_LOG_LINES) {
    logEl.removeChild(logEl.firstChild);
  }
  // One layout read per frame instead of one per line, and only when it is wanted.
  if (pinned) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function clearLog() {
  pendingLines = [];
  if (flushHandle !== null) {
    cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
  logEl.replaceChildren();
}

function appendLog(line) {
  pendingLines.push(line);
  if (flushHandle === null) {
    flushHandle = requestAnimationFrame(flushLog);
  }
}

/* Progress bar ----------------------------------------------------------- */

let progressHandle = null;
let pendingProgress = null;
let shownPercent = -1;

/**
 * Coalesced into one frame and written only when the rounded percentage changes.
 * A 40-track run emits progress several times a second while ffmpeg has the CPU,
 * and a DOM write per event is what makes a bar cost more than the work it
 * describes.
 */
function flushProgress() {
  progressHandle = null;
  const update = pendingProgress;
  pendingProgress = null;
  if (!update) return;

  const indeterminate = Boolean(update.indeterminate);
  progressBar.classList.toggle("indeterminate", indeterminate);

  if (indeterminate) {
    progressBar.removeAttribute("aria-valuenow");
  } else if (update.fraction !== undefined) {
    // An omitted fraction leaves the bar where it is, so ending a cancelled run
    // does not snap it back to zero.
    const percent = Math.round(update.fraction * 100);
    if (percent !== shownPercent) {
      shownPercent = percent;
      progressFill.style.transform = `scaleX(${percent / 100})`;
      progressBar.setAttribute("aria-valuenow", String(percent));
    }
  }

  if (update.label !== undefined) {
    progressEl.textContent = update.label;
  }
}

function setProgress(update) {
  pendingProgress = { ...pendingProgress, ...update };
  if (progressHandle === null) {
    progressHandle = requestAnimationFrame(flushProgress);
  }
}

function resetProgress({ visible }) {
  if (progressHandle !== null) {
    cancelAnimationFrame(progressHandle);
    progressHandle = null;
  }
  pendingProgress = null;
  shownPercent = -1;
  progressFill.style.transform = "scaleX(0)";
  progressBar.classList.remove("indeterminate");
  progressBar.removeAttribute("aria-valuenow");
  progressBar.classList.toggle("hidden", !visible);
  progressEl.textContent = "";
}

/* Navigation ------------------------------------------------------------- */

function isTaskScreen(screen) {
  return screen === SCREEN.DOWNLOAD || screen === SCREEN.LOCAL;
}

function showScreen(screen) {
  currentScreen = screen;
  const task = isTaskScreen(screen);

  homeScreen.classList.toggle("hidden", screen !== SCREEN.HOME);
  taskScreen.classList.toggle("hidden", !task);
  settingsScreen.classList.toggle("hidden", screen !== SCREEN.SETTINGS);
  // The log belongs to a run, so it only exists on a task screen.
  logDetails.classList.toggle("hidden", !task);
  backBtn.classList.toggle("hidden", screen === SCREEN.HOME);
  appSubtitle.classList.toggle("hidden", screen !== SCREEN.HOME);

  if (task) {
    const copy = TASK_COPY[screen];
    taskHeading.textContent = copy.heading;
    taskLead.textContent = copy.lead;
    downloadFields.classList.toggle("hidden", screen !== SCREEN.DOWNLOAD);
    localFields.classList.toggle("hidden", screen !== SCREEN.LOCAL);
    applyModeToOptions(screen === SCREEN.LOCAL);
    // Remembered so a relaunch reopens the task rather than the menu; Settings is
    // a detour and never becomes the landing screen.
    persist(SCREEN_STORAGE_KEY, screen);
  }

  syncOptionAvailability();
  syncStartDisabled();
}

/**
 * Analysis is the whole job locally, so it is forced on there. Coming back to
 * downloads restores the saved preference rather than leaving it stuck on.
 */
function applyModeToOptions(local) {
  if (local) {
    analyzeCheckbox.checked = true;
    analyzeHint.textContent =
      "Always on here: measuring BPM, key and energy is the reason to point at a local folder.";
  } else {
    analyzeCheckbox.checked = read(ANALYZE_STORAGE_KEY) === "1";
    analyzeHint.textContent =
      "Detects BPM, key and energy, and writes cue points into the Rekordbox XML. " +
      "Adds roughly 4% of each track's length.";
  }
  if (!analyzeCheckbox.checked) {
    beatgridCheckbox.checked = false;
    setOrderCheckbox.checked = false;
  } else {
    restoreCheckbox(beatgridCheckbox, BEATGRID_STORAGE_KEY);
    restoreCheckbox(setOrderCheckbox, SET_ORDER_STORAGE_KEY);
  }
}

/* Persistence ------------------------------------------------------------ */

function persist(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; the choice still applies to this session */
  }
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function restoreCheckbox(input, storageKey) {
  input.checked = read(storageKey) === "1";
}

function persistCheckbox(input, storageKey) {
  persist(storageKey, input.checked ? "1" : "0");
}

/* Enablement ------------------------------------------------------------- */

/**
 * One place decides what is usable. Both the run state and the current mode have
 * an opinion about the same controls, and two sets of scattered assignments were
 * how the beatgrid box ended up enabled with nothing to derive a grid from.
 */
function syncOptionAvailability() {
  const local = currentScreen === SCREEN.LOCAL;
  const running = pipelineRunning;
  const analysisOn = analyzeCheckbox.checked;
  analyzeCheckbox.disabled = running || local;
  beatgridCheckbox.disabled = running || !analysisOn;
  setOrderCheckbox.disabled = running || !analysisOn;

  playlistInput.disabled = running;
  audioFormatSelect.disabled = running;
  pickFolderBtn.disabled = running;
  pickFileBtn.disabled = running;
  // Leaving mid-run would hide the bar and the log of a run that is still going.
  backBtn.disabled = running;
}

function syncStartDisabled() {
  const hasSource =
    currentScreen === SCREEN.LOCAL ? Boolean(sourcePathInput.value.trim()) : true;
  startBtn.disabled = pipelineRunning || !setupReady || !hasSource;
}

function setRunning(running) {
  pipelineRunning = running;
  stopBtn.disabled = !running;
  browseBtn.disabled = running;
  proxyInput.disabled = running;
  syncOptionAvailability();
  syncStartDisabled();
}

/* Failures --------------------------------------------------------------- */

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
  failuresCsvNote.textContent = csvPath ? `Details saved to CSV: ${csvPath}` : "";
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

/* Setup check ------------------------------------------------------------ */

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
    appendLog(result.error || "Invalid URL (use YouTube, SoundCloud, or Spotify).");
    return;
  }
  if (result.code === ERROR_CODE.SPOTIFY_CREDENTIALS_MISSING) {
    appendLog(
      "Spotify credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, " +
        "or create ~/.youtube-dj/config.json with " +
        '{"spotify":{"clientId":"...","clientSecret":"..."}}. ' +
        "Get credentials at https://developer.spotify.com/dashboard."
    );
    return;
  }
  if (result.code === ERROR_CODE.SPOTIFY_NOT_FOUND) {
    appendLog(result.error || "Spotify resource not found (private, deleted, or unknown id).");
    return;
  }
  if (result.code === ERROR_CODE.SPOTIFY_API) {
    appendLog(result.error || "Spotify API error.");
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
  if (result.code === ERROR_CODE.GEO_RESTRICTED) {
    appendLog(result.error || "This track is blocked in your region.");
    appendLog(
      "Blocked for your region, and no substitute could be found. Fill in Proxy in Settings " +
        "(for example socks5://127.0.0.1:1080) or connect a VPN, then start again."
    );
    return;
  }
  appendLog(result.error || "Failed.");
}

/* Startup ---------------------------------------------------------------- */

function restoreAudioFormat() {
  const saved = read(AUDIO_FORMAT_STORAGE_KEY);
  if (saved && [...audioFormatSelect.options].some((o) => o.value === saved)) {
    audioFormatSelect.value = saved;
  }
}

async function restoreOutputDir() {
  // The saved folder wins over the default so that renaming the product cannot
  // move where an existing library is written.
  const saved = read(OUTPUT_DIR_STORAGE_KEY);
  if (saved) {
    outputInput.value = saved;
    return;
  }
  try {
    outputInput.value = await window.ytDj.getDefaultOutputDir();
  } catch {
    outputInput.value = "";
  }
}

async function restoreAiSettings() {
  try {
    const settings = await window.ytDj.getAiSettings();
    aiModelInput.value = settings.model || "";
    if (settings.fromEnvironment) {
      aiApiKeyInput.placeholder = "Set by an environment variable";
      aiApiKeyInput.disabled = true;
    } else if (settings.hasApiKey) {
      // Never rendered back into the page; the placeholder just reports that one
      // is saved, and leaving the field untouched keeps it.
      aiApiKeyInput.placeholder = "A key is saved — type to replace it";
    }
  } catch {
    /* settings are optional; the fields just start empty */
  }
}

async function initDefaults() {
  restoreAudioFormat();
  proxyInput.value = read(PROXY_STORAGE_KEY) || "";
  sourcePathInput.value = read(SOURCE_PATH_STORAGE_KEY) || "";
  playlistInput.value = "";
  restoreCheckbox(analyzeCheckbox, ANALYZE_STORAGE_KEY);
  restoreCheckbox(beatgridCheckbox, BEATGRID_STORAGE_KEY);
  restoreCheckbox(setOrderCheckbox, SET_ORDER_STORAGE_KEY);
  await restoreOutputDir();
  await restoreAiSettings();

  const saved = read(SCREEN_STORAGE_KEY);
  showScreen(isTaskScreen(saved) ? saved : SCREEN.HOME);
  resetProgress({ visible: false });
}

/* Events ----------------------------------------------------------------- */

for (const card of document.querySelectorAll("[data-goto]")) {
  card.addEventListener("click", () => showScreen(card.dataset.goto));
}

backBtn.addEventListener("click", () => showScreen(SCREEN.HOME));

audioFormatSelect.addEventListener("change", () => {
  persist(AUDIO_FORMAT_STORAGE_KEY, audioFormatSelect.value);
});

proxyInput.addEventListener("change", () => {
  persist(PROXY_STORAGE_KEY, proxyInput.value.trim());
});

analyzeCheckbox.addEventListener("change", () => {
  // Both are derived from the analysis, so neither can be set on its own.
  if (!analyzeCheckbox.checked) {
    beatgridCheckbox.checked = false;
    setOrderCheckbox.checked = false;
  }
  persistCheckbox(analyzeCheckbox, ANALYZE_STORAGE_KEY);
  persistCheckbox(beatgridCheckbox, BEATGRID_STORAGE_KEY);
  persistCheckbox(setOrderCheckbox, SET_ORDER_STORAGE_KEY);
  syncOptionAvailability();
});

beatgridCheckbox.addEventListener("change", () => {
  persistCheckbox(beatgridCheckbox, BEATGRID_STORAGE_KEY);
});

setOrderCheckbox.addEventListener("change", () => {
  persistCheckbox(setOrderCheckbox, SET_ORDER_STORAGE_KEY);
});

async function pickSource(kind) {
  const picked = await window.ytDj.pickLocalSource(kind);
  if (picked) {
    sourcePathInput.value = picked;
    persist(SOURCE_PATH_STORAGE_KEY, picked);
    syncStartDisabled();
  }
}

pickFolderBtn.addEventListener("click", () => pickSource("folder"));
pickFileBtn.addEventListener("click", () => pickSource("file"));

browseBtn.addEventListener("click", async () => {
  const picked = await window.ytDj.pickOutputDir();
  if (picked) {
    outputInput.value = picked;
    persist(OUTPUT_DIR_STORAGE_KEY, picked);
  }
});

settingsDoneBtn.addEventListener("click", async () => {
  persist(PROXY_STORAGE_KEY, proxyInput.value.trim());
  persist(OUTPUT_DIR_STORAGE_KEY, outputInput.value.trim());

  if (!aiApiKeyInput.disabled) {
    const typed = aiApiKeyInput.value;
    const result = await window.ytDj.setAiSettings({
      // An untouched field must not clear a saved key, so it is only sent when
      // something was actually typed.
      ...(typed === "" ? {} : { apiKey: typed }),
      model: aiModelInput.value.trim()
    });
    if (!result?.ok) {
      settingsStatus.textContent = `Could not save: ${result?.error ?? "unknown error"}`;
      return;
    }
    if (typed !== "") {
      aiApiKeyInput.value = "";
      aiApiKeyInput.placeholder = "A key is saved — type to replace it";
    }
  }

  settingsStatus.textContent = "";
  const previous = read(SCREEN_STORAGE_KEY);
  showScreen(isTaskScreen(previous) ? previous : SCREEN.HOME);
});

recheckSetupBtn.addEventListener("click", () => {
  refreshSetup();
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
  const local = currentScreen === SCREEN.LOCAL;
  const playlistUrl = playlistInput.value.trim();
  const inputPath = sourcePathInput.value.trim();
  const outputRoot = outputInput.value.trim();
  const audioFormat = audioFormatSelect.value;
  const proxy = proxyInput.value.trim();
  const analyze = local || analyzeCheckbox.checked;
  const includeBeatgrid = analyze && beatgridCheckbox.checked;
  const setOrder = analyze && setOrderCheckbox.checked;

  if (local && !inputPath) {
    appendLog("Choose a folder or a file to analyze.");
    return;
  }
  if (!local && !playlistUrl) {
    appendLog("Enter a playlist or track URL.");
    return;
  }
  if (!outputRoot) {
    appendLog("Choose an output folder in Settings.");
    return;
  }

  clearLog();
  clearFailuresUi();
  resetProgress({ visible: true });
  setProgress({ fraction: 0, indeterminate: !local, label: local ? "Reading tracks" : "Loading…" });
  openBtn.disabled = true;
  lastOutputRoot = null;

  unsubLog?.();
  unsubProgress?.();
  unsubLog = window.ytDj.onLog(appendLog);
  // The main process folds each phase's own counter into one fraction, so the bar
  // does not restart when analysis begins.
  unsubProgress = window.ytDj.onProgress(setProgress);

  setRunning(true);
  let result;
  try {
    result = await window.ytDj.start({
      mode: local ? "local" : "url",
      playlistUrl,
      inputPath,
      outputRoot,
      audioFormat,
      proxy,
      analyze,
      includeBeatgrid,
      setOrder
    });
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
      appendLog(local ? "Done: nothing to analyze." : "Done: playlist had no items.");
    } else {
      appendLog(local ? "Done: all tracks analyzed." : "Done: all tracks completed successfully.");
    }
    if (result.ok && result.notesPath) {
      appendLog(`Set notes: ${result.notesPath}`);
    }
  } catch (e) {
    appendLog(String(e?.message || e));
  } finally {
    const finished = result?.ok === true;
    // A failed or cancelled run leaves the bar where it stopped rather than
    // claiming completion or resetting to nothing.
    setProgress({
      ...(finished ? { fraction: 1 } : {}),
      indeterminate: false,
      label: finished ? "Done" : "Stopped"
    });
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
  refreshSetup();
})();
