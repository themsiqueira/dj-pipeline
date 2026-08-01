import { spawn } from "child_process";

/** @type {Set<import('child_process').ChildProcess>} */
const tracked = new Set();

/** SIGTERM gives ffmpeg a chance to close the file; SIGKILL if it does not take it. */
const SIGKILL_ESCALATION_MS = 4000;

export function trackChildProcess(child) {
  tracked.add(child);
  const forget = () => tracked.delete(child);
  child.once("close", forget);
  child.once("error", forget);
}

function isRunning(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
}

/**
 * yt-dlp spawns ffmpeg as a grandchild, so signalling the direct child alone leaves
 * an orphan burning CPU after Stop. On POSIX children are spawned detached (their own
 * process group), so a negative pid signals the whole group; Windows has no groups to
 * signal, so taskkill /T walks the tree instead.
 * @param {import('child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalTree(child, signal) {
  if (!isRunning(child)) return;
  const pid = child.pid;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      }).on("error", () => {});
    } catch {
      /* fall through to the direct kill below */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {import('child_process').ChildProcess} child
 */
export function killChildProcessTree(child) {
  if (!isRunning(child)) return;
  signalTree(child, "SIGTERM");

  if (process.platform === "win32") return;

  const timer = setTimeout(() => signalTree(child, "SIGKILL"), SIGKILL_ESCALATION_MS);
  if (typeof timer.unref === "function") timer.unref();
  child.once("close", () => clearTimeout(timer));
}

export function killAllPipelineChildren() {
  for (const child of [...tracked]) {
    try {
      killChildProcessTree(child);
    } catch {
      /* ignore */
    }
  }
}
