import fs from "fs";
import path from "path";
import { app } from "electron";

/** One rotation, kept small: this is for diagnosing a freeze, not an audit trail. */
const MAX_BYTES = 2 * 1024 * 1024;

let stream = null;
let logPath = null;
let written = 0;

function openStream() {
  try {
    stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
    written = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  } catch {
    stream = null;
  }
}

function rotate() {
  try {
    stream?.end();
  } catch {
    /* ignore */
  }
  stream = null;
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* nothing to rotate */
  }
  openStream();
}

/** @returns {string | null} the log path, or null if logging could not be set up */
export function initLogFile() {
  try {
    const dir = app.getPath("logs");
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, "pipeline.log");
    openStream();
    return stream ? logPath : null;
  } catch {
    return null;
  }
}

export function getLogPath() {
  return logPath;
}

/**
 * Appends one JSON record. Never throws and never blocks: diagnostics must not be
 * able to affect a run.
 * @param {Record<string, unknown>} record
 */
export function logRecord(record) {
  if (!stream) return;
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    written += Buffer.byteLength(line);
    stream.write(line);
    if (written > MAX_BYTES) {
      written = 0;
      rotate();
    }
  } catch {
    /* ignore */
  }
}
