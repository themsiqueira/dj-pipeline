import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ensureDir, sanitizeFilename, writeJson, join, fileExists } from "./util.js";
import { youtubeYtDlpArgs, YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT } from "./yt.js";
import { getYtDlpExecutable, getFfmpegExecutable } from "./binaries.js";
import { spawnTracked, spawnTrackedInherit } from "./spawnUtil.js";
import { isYouTubeUrl } from "./urlPolicy.js";

function stderrLooksLike403Forbidden(err) {
  const chunks = [err.stderr, err.stdout, err.message].filter(Boolean);
  const text = chunks.map((c) => (typeof c === "string" ? c : String(c))).join("\n");
  return /403|Forbidden/i.test(text);
}

/**
 * @param {string} mediaUrl
 * @param {string} tmpDir
 * @param {AbortSignal} [signal]
 */
export async function downloadBestAudio(mediaUrl, tmpDir, signal) {
  ensureDir(tmpDir);

  const token = randomUUID();
  const outTemplate = join(tmpDir, `${token}-%(id)s.%(ext)s`);
  const youtubeArgs = isYouTubeUrl(mediaUrl) ? youtubeYtDlpArgs() : [];
  const tailArgs = [
    "--no-warnings",
    "--no-progress",
    ...youtubeArgs,
    "-f",
    "bestaudio/best",
    "-o",
    outTemplate,
    mediaUrl
  ];

  const yt = getYtDlpExecutable();
  try {
    await spawnTracked(yt, tailArgs, { signal });
  } catch (err) {
    if (err?.message === "Cancelled") throw err;
    if (!isYouTubeUrl(mediaUrl) || !stderrLooksLike403Forbidden(err)) throw err;
    await spawnTracked(
      yt,
      [
        "--no-warnings",
        "--no-progress",
        ...youtubeYtDlpArgs(YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT),
        "-f",
        "bestaudio/best",
        "-o",
        outTemplate,
        mediaUrl
      ],
      { signal }
    );
  }

  const files = fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith(`${token}-`))
    .map((f) => ({ f, m: fs.statSync(join(tmpDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.f);
  if (!files.length) throw new Error(`Download failed for ${mediaUrl}`);
  return join(tmpDir, files[0]);
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {string} logPath
 * @param {{ i?: number, tp?: number, lra?: number }} [target]
 * @param {AbortSignal} [signal]
 */
export async function loudnormTwoPassToMp3(inputPath, outputPath, logPath, target = { i: -9, tp: -1.0, lra: 8 }, signal) {
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

  const args2 = [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-af",
    filter2,
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
    outputPath
  ];

  await spawnTrackedInherit(getFfmpegExecutable(), args2, { signal });

  if (!fileExists(outputPath)) throw new Error(`FFmpeg output missing: ${outputPath}`);
}

/**
 * Filename is the track title only (no playlist index). Duplicate titles in one run
 * become `Title - {stableId}.mp3`.
 * @param {{ title?: string, stableId: string, usedBasenames: Set<string> }} opts
 */
export function makeOutputName({ title, stableId, usedBasenames }) {
  const safeTitle = sanitizeFilename(title || "Unknown Title");
  let name = `${safeTitle}.mp3`;
  if (usedBasenames.has(name)) {
    const idPart = sanitizeFilename(stableId || "unknown");
    name = `${safeTitle} - ${idPart}.mp3`;
  }
  usedBasenames.add(name);
  return name;
}
