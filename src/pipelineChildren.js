import { spawn } from "child_process";

/** @type {Set<import('child_process').ChildProcess>} */
const tracked = new Set();

export function trackChildProcess(child) {
  tracked.add(child);
  child.once("close", () => tracked.delete(child));
  child.once("error", () => tracked.delete(child));
}

export function killAllPipelineChildren() {
  for (const child of [...tracked]) {
    try {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
}
