import { spawn } from "child_process";
import { trackChildProcess } from "./pipelineChildren.js";

/**
 * Spawn a process; kill it when `signal` aborts. Tracks children for global cancel.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function spawnTracked(cmd, args, options = {}) {
  const { signal, env } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error("Cancelled"));
  }

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true
  });

  trackChildProcess(child);

  const onAbort = () => {
    try {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  };

  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  return new Promise((resolve, reject) => {
    const chunksOut = [];
    const chunksErr = [];
    child.stdout?.on("data", (c) => chunksOut.push(c));
    child.stderr?.on("data", (c) => chunksErr.push(c));
    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(chunksOut).toString("utf8");
      const stderr = Buffer.concat(chunksErr).toString("utf8");
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`);
      err.stderr = stderr;
      err.stdout = stdout;
      err.code = code;
      reject(err);
    });
  });
}

/**
 * Spawn with stdout/stderr inherited (e.g. ffmpeg encode). Still tracked and aborted.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ signal?: AbortSignal }} [options]
 */
export function spawnTrackedInherit(cmd, args, options = {}) {
  const { signal } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error("Cancelled"));
  }

  const child = spawn(cmd, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
    windowsHide: true
  });

  trackChildProcess(child);

  const onAbort = () => {
    try {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  };

  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  return new Promise((resolve, reject) => {
    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Process exited with code ${code}`));
    });
  });
}
