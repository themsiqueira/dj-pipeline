import fs from "fs";
import path from "path";
import NodeID3 from "node-id3";
import { getFfmpegExecutable } from "../binaries.js";
import { spawnTrackedQuiet } from "../spawnUtil.js";
import { removeQuiet } from "../util.js";

/**
 * Write measured BPM, key and the detected style into the files themselves.
 *
 * The Rekordbox XML already carries both, so this is about portability: the tags
 * travel with the file into Serato, Traktor, Finder, or a phone.
 *
 * The two formats need opposite treatment. ID3 frames can be updated in place.
 * Vorbis comments cannot — ffmpeg has no in-place tag edit, and FLAC's tags are
 * written during the encode pass, so updating them means remuxing to a new file
 * and swapping it in. That is a stream copy, so it costs a file rewrite but no
 * re-encode and no quality loss.
 */

/**
 * Which container each extension can be tagged through.
 *
 * Downloads only ever produce these two, but a local library is whatever the
 * user already owns, and the rest must be left alone. WAV and AIFF keep metadata
 * in RIFF/IFF chunks and M4A in MP4 atoms; NodeID3 knows none of them and would
 * simply prepend an ID3 header to a file with nowhere to put one, which some
 * players read as corruption.
 */
const TAGGABLE_BY_EXT = new Map([
  [".mp3", "id3"],
  [".flac", "vorbis"]
]);

/** @param {object} analysis @param {object} [style] */
function tagValues(analysis, style) {
  const values = {};
  if (analysis?.bpm) values.bpm = String(Math.round(analysis.bpm));
  if (analysis?.keyClassical) values.key = analysis.keyClassical;
  if (analysis?.camelot) values.camelot = analysis.camelot;
  if (analysis?.energyLevel) values.energy = String(analysis.energyLevel);
  // Only overwrite the genre when a style was actually determined; an undetermined
  // track keeps whatever the source supplied.
  if (style?.style) values.genre = titleCase(style.style);
  return values;
}

/** "melodic techno" as DJ software displays it. */
function titleCase(value) {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function writeMp3Tags(filePath, analysis, style) {
  const { bpm, key, camelot, energy, genre } = tagValues(analysis, style);

  /** @type {Record<string, unknown>} */
  const tags = {};
  if (bpm) tags.bpm = bpm;
  if (key) tags.initialKey = key;
  if (genre) tags.genre = genre;

  // Camelot and energy have no standard frame, so they go in TXXX where other DJ
  // software looks for them.
  const userDefined = [];
  if (camelot) userDefined.push({ description: "CAMELOTKEY", value: camelot });
  if (energy) userDefined.push({ description: "ENERGYLEVEL", value: energy });
  if (userDefined.length) tags.userDefinedText = userDefined;

  if (!Object.keys(tags).length) return;

  // Update rather than write: a full write would drop the cover art and the
  // title/artist frames already applied during the download phase.
  const ok = NodeID3.update(tags, filePath);
  if (!ok) throw new Error(`Failed to update ID3 tags: ${filePath}`);
}

async function writeFlacTags(filePath, analysis, style, signal) {
  const { bpm, key, camelot, energy, genre } = tagValues(analysis, style);
  const metadata = [];
  if (bpm) metadata.push("-metadata", `BPM=${bpm}`);
  if (key) metadata.push("-metadata", `INITIALKEY=${key}`);
  if (camelot) metadata.push("-metadata", `CAMELOTKEY=${camelot}`);
  if (energy) metadata.push("-metadata", `ENERGYLEVEL=${energy}`);
  if (genre) metadata.push("-metadata", `GENRE=${genre}`);
  if (!metadata.length) return;

  const tempPath = `${filePath}.retag.flac`;
  try {
    await spawnTrackedQuiet(
      getFfmpegExecutable(),
      [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        "-i",
        filePath,
        // Keep the attached cover picture alongside the audio.
        "-map",
        "0",
        "-c",
        "copy",
        ...metadata,
        "-f",
        "flac",
        tempPath
      ],
      { signal }
    );

    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    await removeQuiet(tempPath);
    throw err;
  }
}

/**
 * @param {Array<object>} tracks tracks carrying `analysis` from the analysis phase
 * @param {{ signal?: AbortSignal, log?: (line: string) => void }} [options]
 */
export async function applyAnalysisTags(tracks, options = {}) {
  const { signal, log = () => {} } = options;
  /** @type {Map<string, number>} */
  const skippedByExt = new Map();

  for (const track of tracks) {
    if (!track?.filePath) continue;
    // A track whose audio failed to analyse can still have a style off its title,
    // which is worth writing on its own.
    if (!track.analysis && !track.style?.style) continue;
    if (signal?.aborted) throw new Error("Cancelled");

    const ext = path.extname(track.filePath).toLowerCase();
    const container = TAGGABLE_BY_EXT.get(ext);
    if (!container) {
      skippedByExt.set(ext || "(no extension)", (skippedByExt.get(ext || "(no extension)") ?? 0) + 1);
      continue;
    }

    try {
      if (container === "vorbis") {
        await writeFlacTags(track.filePath, track.analysis, track.style, signal);
      } else {
        writeMp3Tags(track.filePath, track.analysis, track.style);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // The XML still carries BPM and key, so a failed tag write costs
      // portability, not the run.
      log(`  ${track.title}: could not write analysis tags (${err?.message ?? "unknown error"})`);
    }
  }

  // One line for the whole run: a library of a few hundred WAVs should not
  // produce a few hundred identical warnings.
  for (const [ext, count] of skippedByExt) {
    log(
      `  ${count} ${ext} ${count === 1 ? "file" : "files"} left untagged: the format has no ID3 or Vorbis tags. ` +
        "BPM, key and style are still in the Rekordbox XML."
    );
  }
}
