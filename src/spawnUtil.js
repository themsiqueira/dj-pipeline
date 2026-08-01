import { spawn } from "child_process";
import { trackChildProcess, killChildProcessTree } from "./pipelineChildren.js";
import { recordDiagnostic, summarizeArgs } from "./diagnostics.js";

/** Guards against a pathological `--dump-single-json` eating all memory. */
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** Enough tail to carry a real ffmpeg error, small enough to never matter. */
const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * @param {number} limitBytes
 * @param {"all" | "tail"} keep
 */
function createOutputSink(limitBytes, keep) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let overflowed = false;

  return {
    /** @returns {boolean} false when the caller must abort the child */
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      if (size <= limitBytes) return true;

      if (keep === "tail") {
        while (chunks.length > 1 && size - chunks[0].length >= limitBytes) {
          size -= chunks.shift().length;
        }
        return true;
      }

      overflowed = true;
      return false;
    },
    get overflowed() {
      return overflowed;
    },
    buffer() {
      return Buffer.concat(chunks);
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

/**
 * Spawn a process, always draining stdout/stderr, and kill its whole tree when
 * `signal` aborts.
 *
 * Both streams are piped and read even when the output is discarded: an undrained
 * pipe fills at ~64 KB and blocks the child forever, which is how a single ffmpeg
 * encode used to hang the whole run.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv, maxBuffer?: number, keep?: "all" | "tail", binary?: boolean }} [options]
 * @returns {Promise<{ stdout: string | Buffer, stderr: string }>}
 */
export function spawnTracked(cmd, args, options = {}) {
  const {
    signal,
    env,
    keep = "all",
    binary = false,
    maxBuffer = keep === "tail" ? DEFAULT_TAIL_BYTES : DEFAULT_MAX_BUFFER_BYTES
  } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error("Cancelled"));
  }

  const startedAt = Date.now();
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    // Own process group on POSIX so cancel can reap grandchildren (yt-dlp -> ffmpeg).
    detached: process.platform !== "win32"
  });

  trackChildProcess(child);

  const onAbort = () => killChildProcessTree(child);
  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  return new Promise((resolve, reject) => {
    const out = createOutputSink(maxBuffer, keep);
    const err = createOutputSink(keep === "tail" ? maxBuffer : DEFAULT_TAIL_BYTES, "tail");
    let overflowKilled = false;

    child.stdout?.on("data", (c) => {
      if (!out.push(c)) {
        overflowKilled = true;
        killChildProcessTree(child);
      }
    });
    child.stderr?.on("data", (c) => err.push(c));

    const finish = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      finish();
      recordDiagnostic({
        event: "spawn.error",
        cmd,
        args: summarizeArgs(args),
        ms: Date.now() - startedAt,
        message: error?.message
      });
      reject(error);
    });

    child.on("close", (code) => {
      finish();
      const ms = Date.now() - startedAt;
      recordDiagnostic({ event: "spawn.close", cmd, args: summarizeArgs(args), ms, exitCode: code });

      const stdout = binary ? out.buffer() : out.text();
      const stderr = err.text();

      if (overflowKilled) {
        reject(new Error(`Output from ${cmd} exceeded ${maxBuffer} bytes and was aborted.`));
        return;
      }
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        stderr.trim() || (binary ? "" : stdout.trim()) || `Process exited with code ${code}`
      );
      error.stderr = stderr;
      error.stdout = stdout;
      // Deliberately not `code`: that is reserved for PIPELINE_ERROR classification.
      error.exitCode = code;
      reject(error);
    });
  });
}

/**
 * For long-running encodes whose output is only interesting when they fail.
 * Retains the tail of stderr so a failure carries a real ffmpeg message instead
 * of a bare exit code.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function spawnTrackedQuiet(cmd, args, options = {}) {
  return spawnTracked(cmd, args, { ...options, keep: "tail" });
}

/**
 * For processes whose stdout is raw bytes rather than text — decoding audio to PCM
 * would be corrupted by the utf8 round-trip the other variants do.
 *
 * `maxBuffer` has to be far larger than the text default: a 10-minute track at
 * 44.1 kHz mono float32 is ~105 MB.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv, maxBuffer?: number }} [options]
 * @returns {Promise<{ stdout: Buffer, stderr: string }>}
 */
export function spawnTrackedBinary(cmd, args, options = {}) {
  return spawnTracked(cmd, args, {
    maxBuffer: 512 * 1024 * 1024,
    ...options,
    binary: true,
    keep: "all"
  });
}
