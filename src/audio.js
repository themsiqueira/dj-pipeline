import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { ensureDir, sanitizeFilename, writeJson, join, fileExists } from "./util.js";
import { youtubeYtDlpArgs, YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT } from "./yt.js";
import { getYtDlpExecutable, getFfmpegExecutable } from "./binaries.js";

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function stderrLooksLike403Forbidden(err) {
  const chunks = [err.stderr, err.stdout, err.message].filter(Boolean);
  const text = chunks.map((c) => (typeof c === "string" ? c : String(c))).join("\n");
  return /403|Forbidden/i.test(text);
}

export function downloadBestAudio(videoUrl, tmpDir) {
  ensureDir(tmpDir);

  // Download best audio into tmp as .m4a/.webm (no conversion yet)
  const outTemplate = join(tmpDir, "%(id)s.%(ext)s");
  const tailArgs = [
    "--no-warnings",
    "--no-progress",
    ...youtubeYtDlpArgs(),
    "-f", "bestaudio/best",
    "-o", outTemplate,
    videoUrl
  ];

  const yt = getYtDlpExecutable();
  try {
    run(yt, tailArgs, { encoding: "utf-8" });
  } catch (err) {
    if (!stderrLooksLike403Forbidden(err)) throw err;
    run(
      yt,
      [
        "--no-warnings",
        "--no-progress",
        ...youtubeYtDlpArgs(YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT),
        "-f", "bestaudio/best",
        "-o", outTemplate,
        videoUrl
      ],
      { encoding: "utf-8" }
    );
  }

  // Find the downloaded file by id prefix
  const id = new URL(videoUrl).searchParams.get("v") ?? "";
  const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(id + "."));
  if (!files.length) throw new Error(`Download failed for ${videoUrl}`);
  return join(tmpDir, files[0]);
}

export function loudnormTwoPassToMp3(inputPath, outputPath, logPath, target = { i: -9, tp: -1.0, lra: 8 }) {
  ensureDir(path.dirname(outputPath));
  ensureDir(path.dirname(logPath));

  // Pass 1: analysis
  // ffmpeg prints json to stderr, so we need to capture it properly
  const filter1 = `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`;
  const args1 = ["-hide_banner", "-i", inputPath, "-af", filter1, "-f", "null", "-"];
  
  // Use spawnSync to capture stderr even when command succeeds
  const result = spawnSync(getFfmpegExecutable(), args1, {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf-8"
  });

  const stderr1 = result.stderr || "";
  
  // Extract JSON from stderr (ffmpeg outputs it there)
  const jsonMatch = stderr1.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // If no JSON found, check if there was an actual error
    if (result.status !== 0 && result.status !== null) {
      throw new Error(`FFmpeg analysis failed: ${stderr1}`);
    }
    throw new Error(`Could not parse loudnorm analysis JSON. stderr: ${stderr1.slice(0, 500)}`);
  }
  
  let analysis;
  try {
    analysis = JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    throw new Error(`Failed to parse loudnorm JSON: ${parseError.message}\nJSON: ${jsonMatch[0]}`);
  }
  
  writeJson(logPath, analysis);

  // Pass 2: apply measured values
  const filter2 =
    `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}` +
    `:measured_I=${analysis.input_i}` +
    `:measured_TP=${analysis.input_tp}` +
    `:measured_LRA=${analysis.input_lra}` +
    `:measured_thresh=${analysis.input_thresh}` +
    `:offset=${analysis.target_offset}` +
    `:linear=true:print_format=summary`;

  // MP3 320 CBR, 44.1kHz stereo
  const args2 = [
    "-hide_banner",
    "-y",
    "-i", inputPath,
    "-af", filter2,
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "libmp3lame",
    "-b:a", "320k",
    "-write_xing", "0",
    outputPath
  ];

  execFileSync(getFfmpegExecutable(), args2, { stdio: "inherit" });

  if (!fileExists(outputPath)) throw new Error(`FFmpeg output missing: ${outputPath}`);
}

export function makeOutputName({ index, title }) {
  const safeTitle = sanitizeFilename(title || "Unknown Title");
  const pad = String(index).padStart(2, "0");
  return `${pad} - ${safeTitle}.mp3`;
}

