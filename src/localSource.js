import fs from "fs";
import path from "path";
import NodeID3 from "node-id3";
import { probeMedia } from "./mediaProbe.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fileSizeQuiet } from "./util.js";

/**
 * Read an existing library off disk as pipeline tracks.
 *
 * Nothing here copies, converts or moves anything: the track's `filePath` is the
 * user's own file, so the analysis writes tags into it and the Rekordbox XML
 * points at where it already lives. That is how Rekordbox and Mixed In Key treat
 * a library, and it is the only behaviour that does not silently double the size
 * of someone's music folder.
 */

/**
 * Restricted to what Rekordbox itself can play. Scanning an Opus file would only
 * produce a collection entry that Rekordbox refuses to load.
 */
export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".aiff",
  ".aif",
  ".m4a",
  ".aac"
]);

/** A backstop against symlink cycles rather than a real limit on how deep a library nests. */
const MAX_SCAN_DEPTH = 12;

/** Numeric so "track2" sorts before "track10", which is the order a person expects. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Skips dotfiles, and with them macOS's `._name` AppleDouble stubs — those carry
 * the extension of the file they shadow, so a naive scan reports every track twice.
 */
function isHidden(name) {
  return name.startsWith(".");
}

export function isSupportedAudioFile(filePath) {
  return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * @param {string} inputPath a file or a folder
 * @returns {string[]} absolute paths, sorted
 */
export function scanAudioFiles(inputPath) {
  const root = path.resolve(inputPath);
  const stats = fs.statSync(root);

  if (stats.isFile()) {
    return isSupportedAudioFile(root) ? [root] : [];
  }

  /** @type {string[]} */
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable subfolder should cost that subfolder, not the scan.
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // Symlinked directories are not followed: a link back to an ancestor would
      // otherwise walk until the depth cap, reporting the same files many times.
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && isSupportedAudioFile(full)) {
        found.push(full);
      }
    }
  };

  walk(root, 0);
  return found.sort((a, b) => COLLATOR.compare(a, b));
}

/**
 * Pull artist and title out of a filename when the tags do not have them.
 *
 * "01 - Artist - Title (Remix).mp3" is the shape almost every download and rip
 * uses, and it is far better than showing a hyphenated filename as the title.
 *
 * @param {string} filePath
 * @returns {{ title: string, artist: string }}
 */
export function parseTrackFilename(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  // Leading track numbers: "01 ", "01. ", "01 - ", "01_".
  const withoutIndex = stem.replace(/^\s*\d{1,3}\s*[-._)]\s*|^\s*\d{1,3}\s+/, "").trim();
  const source = withoutIndex || stem;

  // Only " - " with spaces: a hyphen without them belongs to names like "Jean-Michel".
  const split = source.indexOf(" - ");
  if (split > 0) {
    const artist = source.slice(0, split).trim();
    const title = source.slice(split + 3).trim();
    if (artist && title) return { title, artist };
  }
  return { title: source.trim() || stem, artist: "" };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

/** node-id3 returns trackNumber as "4" or "4/12". */
function parseTrackNumber(value) {
  const n = parseInt(String(value ?? "").split("/")[0], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseYear(value) {
  const m = /\d{4}/.exec(String(value ?? ""));
  return m ? m[0] : "";
}

/**
 * MP3s are read in-process; everything else needs ffmpeg. That split is worth
 * keeping: a library of a few thousand MP3s reads instantly, where one ffmpeg
 * launch per file would take minutes before the first note is analysed.
 *
 * @param {string} filePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ tags: Record<string, string>, durationSec: number }>}
 */
async function readTags(filePath, options = {}) {
  if (path.extname(filePath).toLowerCase() === ".mp3") {
    try {
      const id3 = NodeID3.read(filePath) || {};
      return {
        tags: {
          title: id3.title ?? "",
          artist: id3.artist ?? "",
          album: id3.album ?? "",
          genre: id3.genre ?? "",
          date: id3.year ?? id3.recordingTime ?? "",
          track: id3.trackNumber ?? ""
        },
        // ID3 has no reliable duration frame; the analysis supplies it, and the
        // ffmpeg probe covers whatever the analysis could not read.
        durationSec: 0
      };
    } catch {
      return { tags: {}, durationSec: 0 };
    }
  }

  try {
    return await probeMedia(filePath, options);
  } catch {
    return { tags: {}, durationSec: 0 };
  }
}

/**
 * Folder names are a genuine signal in a DJ library — people file tracks under
 * "Melodic Techno" and "Peak Time" — so the path between the scan root and the
 * file is handed to the classifier alongside the filename.
 *
 * @param {string} filePath
 * @param {string} rootDir
 */
function pathHints(filePath, rootDir) {
  const relative = path.relative(rootDir, path.dirname(filePath));
  if (!relative || relative.startsWith("..")) return [];
  return relative.split(path.sep).filter(Boolean);
}

/**
 * @param {object} options
 * @param {string} options.inputPath file or folder to read
 * @param {AbortSignal} [options.signal]
 * @param {(line: string) => void} [options.onLog]
 * @param {(p: { current: number, total: number, title: string }) => void} [options.onProgress]
 * @returns {Promise<{ tracks: object[], sourceName: string }>} tracks in the shape the pipeline's download phase produces
 */
export async function loadLocalTracks({ inputPath, signal, onLog, onProgress } = {}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const report = typeof onProgress === "function" ? onProgress : () => {};

  const resolved = path.resolve(String(inputPath ?? ""));
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`Not found: ${resolved}`);
  }

  const isDirectory = stats.isDirectory();
  const rootDir = isDirectory ? resolved : path.dirname(resolved);
  const sourceName = isDirectory
    ? path.basename(resolved) || resolved
    : parseTrackFilename(resolved).title;

  const files = scanAudioFiles(resolved);
  if (files.length === 0) {
    const supported = [...SUPPORTED_AUDIO_EXTENSIONS].join(", ");
    throw new Error(
      isDirectory
        ? `No supported audio files found in ${resolved}. Looked for: ${supported}.`
        : `${resolved} is not a supported audio file. Supported: ${supported}.`
    );
  }

  log(`Source: ${resolved}`);
  log(`Found ${files.length} ${files.length === 1 ? "track" : "tracks"}.`);

  let done = 0;
  // Modest: reading tags is I/O bound and, for non-MP3, one short ffmpeg launch.
  const tracks = await mapWithConcurrency(files, 4, async (filePath) => {
    if (signal?.aborted) throw new Error("Cancelled");

    const { tags, durationSec } = await readTags(filePath, { signal });
    const fromName = parseTrackFilename(filePath);
    const title = firstNonEmpty(tags.title, fromName.title);
    const artist = firstNonEmpty(tags.artist, tags.album_artist, fromName.artist);
    const folders = pathHints(filePath, rootDir);
    const stem = path.basename(filePath, path.extname(filePath));

    done += 1;
    report({ current: done, total: files.length, title });

    return {
      title,
      artist,
      album: firstNonEmpty(tags.album),
      trackNumber: parseTrackNumber(tags.track),
      year: parseYear(tags.date),
      genre: firstNonEmpty(tags.genre),
      durationSec,
      styleHints: {
        title,
        uploader: artist,
        // The user's own genre tag is the most reliable source there is: unlike a
        // YouTube upload, someone chose it for this file deliberately.
        genre: firstNonEmpty(tags.genre),
        // The filename often names a style the title does not ("... (Hard Techno
        // Remix)"), and the folder it sits in frequently names one outright.
        tags: [stem, ...folders],
        description: ""
      },
      comment: "",
      filePath,
      stem,
      format: path.extname(filePath).slice(1).toLowerCase(),
      sizeBytes: fileSizeQuiet(filePath)
    };
  });

  return { tracks, sourceName };
}
