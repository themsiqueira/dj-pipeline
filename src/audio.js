import fs from "fs";
import path from "path";
import { ensureDir, sanitizeFilename, writeJson, fileExists } from "./util.js";
import { getFfmpegExecutable } from "./binaries.js";
import { spawnTracked, spawnTrackedQuiet } from "./spawnUtil.js";
import { AUDIO_FORMAT, DEFAULT_AUDIO_FORMAT, normalizeAudioFormat } from "./audioFormats.js";

const CHANNELS_BY_LAYOUT = {
  mono: 1,
  stereo: 2,
  "2.1": 3,
  quad: 4,
  "4.0": 4,
  "5.0": 5,
  "5.1": 6,
  "6.1": 7,
  "7.1": 8
};

/**
 * Reads the input stream line ffmpeg prints on stderr, e.g.
 * `Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp`. Avoids a separate ffprobe
 * call, which is not bundled in vendor/.
 * @param {string} stderr
 * @returns {{ rate: number, channels: number }}
 */
export function parseSourceLayout(stderr) {
  const match = String(stderr || "").match(/Audio:\s[^\n]*?(\d{4,6})\s*Hz,\s*([^,\n]+)/i);
  if (!match) return { rate: 44100, channels: 2 };

  const rate = Number(match[1]);
  const layout = match[2].trim().toLowerCase().replace(/\(.*\)$/, "");
  return {
    rate: Number.isFinite(rate) && rate >= 8000 && rate <= 384000 ? rate : 44100,
    channels: CHANNELS_BY_LAYOUT[layout] ?? 2
  };
}

/**
 * FLAC carries Vorbis comments, which node-id3 cannot write, so ffmpeg tags during the encode.
 * @param {object | null} meta
 */
function vorbisMetadataArgs(meta) {
  if (!meta) return [];
  const fields = {
    title: meta.title,
    artist: meta.artist ?? meta.uploader,
    album: meta.album ?? meta.playlist_title,
    track: meta.trackNumber,
    date: meta.year,
    genre: meta.genre,
    comment: meta.webpage_url ? `Source: ${meta.webpage_url}` : ""
  };

  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    const text = value == null ? "" : String(value).trim();
    if (text) args.push("-metadata", `${key}=${text}`);
  }
  return args;
}

/**
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {string} opts.outputPath
 * @param {string} opts.filter
 * @param {"mp3" | "flac"} opts.format
 * @param {{ rate: number, channels: number }} opts.source
 * @param {string | null} opts.coverPath
 * @param {object | null} opts.meta
 */
function buildEncodeArgs({ inputPath, outputPath, filter, format, source, coverPath, meta }) {
  // `-nostats` keeps the progress spam out of the pipe; the container has to be named
  // explicitly because the output is written to a `.part` file ffmpeg cannot infer from.
  const head = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i", inputPath];

  if (format !== AUDIO_FORMAT.FLAC) {
    return [
      ...head,
      "-af",
      filter,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "320k",
      "-write_xing",
      "0",
      "-f",
      "mp3",
      outputPath
    ];
  }

  const args = [...head];
  if (coverPath) args.push("-i", coverPath);

  args.push("-map", "0:a:0");
  if (coverPath) args.push("-map", "1:v:0");

  args.push(
    "-af",
    filter,
    // loudnorm resamples to 192 kHz internally, so the source rate must be restored explicitly.
    "-ar",
    String(source.rate),
    "-ac",
    String(source.channels),
    "-c:a",
    "flac",
    "-sample_fmt",
    "s32",
    // Level 8 costs markedly more CPU than the default 5 for a few percent of size.
    "-compression_level",
    "5"
  );

  if (coverPath) {
    args.push(
      "-c:v",
      "mjpeg",
      "-disposition:v:0",
      "attached_pic",
      "-metadata:s:v",
      "title=Album cover",
      "-metadata:s:v",
      "comment=Cover (front)"
    );
  }

  args.push(...vorbisMetadataArgs(meta), "-f", "flac", outputPath);
  return args;
}

/**
 * Two-pass loudnorm, then encode to `format`. MP3 is normalized to 44.1 kHz stereo;
 * FLAC keeps the source rate and channel count at 24-bit.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {string} logPath
 * @param {{ i?: number, tp?: number, lra?: number }} [target]
 * @param {AbortSignal} [signal]
 * @param {{ format?: string, coverPath?: string | null, meta?: object | null, onLog?: (line: string) => void }} [options]
 */
export async function loudnormTwoPassEncode(
  inputPath,
  outputPath,
  logPath,
  target = { i: -9, tp: -1.0, lra: 8 },
  signal,
  options = {}
) {
  const format = normalizeAudioFormat(options.format ?? DEFAULT_AUDIO_FORMAT);
  const meta = options.meta ?? null;
  const log = typeof options.onLog === "function" ? options.onLog : () => {};
  const coverPath =
    format === AUDIO_FORMAT.FLAC && options.coverPath && fileExists(options.coverPath)
      ? options.coverPath
      : null;

  ensureDir(path.dirname(outputPath));
  ensureDir(path.dirname(logPath));

  const filter1 = `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`;
  const args1 = ["-hide_banner", "-i", inputPath, "-af", filter1, "-f", "null", "-"];

  const result = await spawnTracked(getFfmpegExecutable(), args1, { signal });
  const stderr1 = result.stderr || "";

  const jsonMatch = stderr1.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Could not parse loudnorm analysis JSON. stderr: ${stderr1.slice(0, 500)}`);
  }

  let analysis;
  try {
    analysis = JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    throw new Error(`Failed to parse loudnorm JSON: ${parseError.message}\nJSON: ${jsonMatch[0]}`);
  }

  writeJson(logPath, analysis);

  const filter2 =
    `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}` +
    `:measured_I=${analysis.input_i}` +
    `:measured_TP=${analysis.input_tp}` +
    `:measured_LRA=${analysis.input_lra}` +
    `:measured_thresh=${analysis.input_thresh}` +
    `:offset=${analysis.target_offset}` +
    `:linear=true:print_format=summary`;

  const source = parseSourceLayout(stderr1);
  // Encode to a sibling `.part` and rename only on success, so a cancelled or failed
  // ffmpeg can never leave a truncated file that looks importable.
  const partPath = `${outputPath}.part`;
  const encodeArgs = (cover) =>
    buildEncodeArgs({
      inputPath,
      outputPath: partPath,
      filter: filter2,
      format,
      source,
      coverPath: cover,
      meta
    });

  const removePart = async () => {
    try {
      await fs.promises.rm(partPath, { force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    try {
      await spawnTrackedQuiet(getFfmpegExecutable(), encodeArgs(coverPath), { signal });
    } catch (err) {
      if (!coverPath || err?.message === "Cancelled" || signal?.aborted) throw err;
      const detail = (err?.message || "").split("\n").pop()?.trim();
      log(
        `  Warning: could not embed cover art; encoding ${format.toUpperCase()} without it.` +
          (detail ? ` (${detail})` : "")
      );
      await removePart();
      await spawnTrackedQuiet(getFfmpegExecutable(), encodeArgs(null), { signal });
    }
  } catch (err) {
    await removePart();
    throw err;
  }

  if (!fileExists(partPath)) throw new Error(`FFmpeg output missing: ${outputPath}`);
  await fs.promises.rename(partPath, outputPath);
}

/**
 * Filename is the track title only (no playlist index). Duplicate titles in one run
 * become `Title - {stableId}.{ext}`.
 * @param {{ title?: string, stableId: string, usedBasenames: Set<string>, ext?: string }} opts
 */
export function makeOutputName({ title, stableId, usedBasenames, ext = DEFAULT_AUDIO_FORMAT }) {
  const safeTitle = sanitizeFilename(title || "Unknown Title");
  let name = `${safeTitle}.${ext}`;
  if (usedBasenames.has(name)) {
    const idPart = sanitizeFilename(stableId || "unknown");
    name = `${safeTitle} - ${idPart}.${ext}`;
  }
  usedBasenames.add(name);
  return name;
}
