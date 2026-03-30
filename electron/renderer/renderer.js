const $ = (id) => document.getElementById(id);

const playlistInput = $("playlistUrl");
const outputInput = $("outputDir");
const browseBtn = $("browseBtn");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const openBtn = $("openBtn");
const logEl = $("log");
const progressEl = $("progress");

let lastOutputRoot = null;
let unsubLog = null;
let unsubProgress = null;

function appendLog(line) {
  logEl.textContent += (logEl.textContent ? "\n" : "") + line;
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  browseBtn.disabled = running;
  playlistInput.disabled = running;
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
    appendLog("Enter a playlist URL.");
    return;
  }
  if (!outputRoot) {
    appendLog("Choose an output folder.");
    return;
  }

  logEl.textContent = "";
  progressEl.textContent = "";
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
      appendLog(result.error || "Failed.");
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

initDefaults();
