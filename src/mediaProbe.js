import { getFfmpegExecutable } from "./binaries.js";
import { spawnTracked } from "./spawnUtil.js";

/**
 * Read tags and duration out of an audio file's header with ffmpeg.
 *
 * ffprobe would be the obvious tool, but only ffmpeg is bundled (see
 * `scripts/fetch-native-tools.mjs`), and `-f ffmetadata -` gets the same tags out
 * of the same library. Duration comes from the input banner ffmpeg writes to
 * stderr while it is there, so one launch answers both questions.
 *
 * Nothing is decoded: ffmpeg reads the header, dumps the metadata and exits, so
 * this costs milliseconds even on a lossless file.
 */

/** `Duration: 00:04:12.34, start: ...` */
const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Characters ffmpeg escapes with a backslash inside ffmetadata values. */
const UNESCAPE_RE = /\\([=;#\\\n])/g;

/** True when the trailing backslash is a line continuation rather than an escaped one. */
function hasTrailingContinuation(line) {
  let backslashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** Index of the first `=` that is not itself escaped. */
function unescapedEqualsIndex(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") {
      i += 1;
      continue;
    }
    if (line[i] === "=") return i;
  }
  return -1;
}

/**
 * Parse the global tag block of an ffmetadata dump. Per-stream and per-chapter
 * sections are ignored: a file's title lives in the global block, and a stream's
 * own title is usually something like "Audio".
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseFfmetadata(text) {
  /** @type {Record<string, string>} */
  const tags = {};
  const lines = String(text ?? "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    // [STREAM] / [CHAPTER]: everything after belongs to a sub-section.
    if (line.startsWith("[")) break;

    // A value may span lines, each continued one ending in a lone backslash.
    while (hasTrailingContinuation(line) && i + 1 < lines.length) {
      i += 1;
      line = `${line.slice(0, -1)}\n${lines[i]}`;
    }

    const split = unescapedEqualsIndex(line);
    if (split <= 0) continue;

    const key = line.slice(0, split).replace(UNESCAPE_RE, "$1").trim().toLowerCase();
    const value = line.slice(split + 1).replace(UNESCAPE_RE, "$1").trim();
    // First wins: ffmpeg emits the container's tags before any duplicates.
    if (key && value && !(key in tags)) tags[key] = value;
  }

  return tags;
}

/**
 * @param {string} stderr ffmpeg's input banner
 * @returns {number} seconds, or 0 when ffmpeg reported no duration
 */
export function parseDurationSec(stderr) {
  const m = DURATION_RE.exec(String(stderr ?? ""));
  if (!m) return 0;
  const [, hours, minutes, seconds] = m;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) ? total : 0;
}

/**
 * @param {string} filePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ durationSec: number, tags: Record<string, string> }>}
 */
export async function probeMedia(filePath, options = {}) {
  const { signal } = options;
  const { stdout, stderr } = await spawnTracked(
    getFfmpegExecutable(),
    ["-hide_banner", "-i", filePath, "-f", "ffmetadata", "-"],
    // The banner carries the duration, so stderr has to be kept rather than
    // silenced, but only the tail of it is of any use.
    { signal, keep: "tail" }
  );

  return { durationSec: parseDurationSec(stderr), tags: parseFfmetadata(stdout) };
}

/**
 * Duration alone, never throwing.
 *
 * Used where a missing value is worse than a wrong one: Rekordbox discards a
 * track's cue points when `TotalTime` is 0, so a file whose analysis failed still
 * needs its length from somewhere.
 *
 * @param {string} filePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<number>} seconds, or 0 when it could not be read
 */
export async function probeDurationQuiet(filePath, options = {}) {
  try {
    const { durationSec } = await probeMedia(filePath, options);
    return durationSec;
  } catch {
    return 0;
  }
}
