import fs from "fs";
import path from "path";
import { ensureDir, join } from "./util.js";
import { getYtDlpExecutable } from "./binaries.js";
import { spawnTracked } from "./spawnUtil.js";

/** Default YouTube player clients; retry downloads may use {@link YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT}. */
const DEFAULT_YOUTUBE_PLAYER_CLIENT = "web_embedded,default";

/**
 * Extra yt-dlp CLI tokens for YouTube (SABR/403 workarounds). Keep yt-dlp updated: `pip install -U yt-dlp`.
 * Set `YTDLP_COOKIES_FROM_BROWSER` (e.g. `chrome`) if downloads still return 403.
 */
export function youtubeYtDlpArgs(playerClientSpec = DEFAULT_YOUTUBE_PLAYER_CLIENT) {
  const args = ["--extractor-args", `youtube:player_client=${playerClientSpec}`];
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (browser) {
    args.push("--cookies-from-browser", browser);
  }
  return args;
}

/** Alternate player_client list for a single retry after HTTP 403 on the media URL. */
export const YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT = "android,web";

function stderrLooksLike403Forbidden(err) {
  const chunks = [err.stderr, err.stdout, err.message].filter(Boolean);
  const text = chunks.map((c) => (typeof c === "string" ? c : String(c))).join("\n");
  return /403|Forbidden/i.test(text);
}

/**
 * @param {string} playlistUrl
 * @param {string[]} [extraArgs]
 * @param {AbortSignal} [signal]
 */
export async function ytDlpJson(playlistUrl, extraArgs = [], signal) {
  const args = [
    "--dump-single-json",
    "--yes-playlist",
    "--flat-playlist",
    ...youtubeYtDlpArgs(),
    ...extraArgs,
    playlistUrl
  ];

  const yt = getYtDlpExecutable();
  try {
    const { stdout } = await spawnTracked(yt, args, { signal });
    return JSON.parse(stdout);
  } catch (error) {
    const errorMsg = error.stderr?.toString() || error.message || "Unknown error";
    throw new Error(`Failed to fetch playlist: ${errorMsg}\nURL: ${playlistUrl}`);
  }
}

/**
 * @param {string} videoUrl
 * @param {string[]} [extraArgs]
 * @param {AbortSignal} [signal]
 */
export async function ytDlpVideoJson(videoUrl, extraArgs = [], signal) {
  const args = ["--dump-single-json", ...youtubeYtDlpArgs(), ...extraArgs, videoUrl];
  const yt = getYtDlpExecutable();
  try {
    const { stdout } = await spawnTracked(yt, args, { signal });
    return JSON.parse(stdout);
  } catch (error) {
    const errorMsg = error.stderr?.toString() || error.message || "Unknown error";
    throw new Error(`Failed to fetch video metadata: ${errorMsg}\nURL: ${videoUrl}`);
  }
}

export function buildVideoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * @param {string} videoUrl
 * @param {string} outputPath
 * @param {AbortSignal} [signal]
 */
export async function downloadThumbnail(videoUrl, outputPath, signal) {
  ensureDir(path.dirname(outputPath));

  const args = [
    "--no-warnings",
    ...youtubeYtDlpArgs(),
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "-o",
    outputPath.replace(/\.jpg$/, ""),
    videoUrl
  ];

  const yt = getYtDlpExecutable();
  try {
    await spawnTracked(yt, args, { signal });

    const dir = path.dirname(outputPath);
    const videoId = new URL(videoUrl).searchParams.get("v") ?? "";
    const files = fs.readdirSync(dir).filter(
      (f) => f.startsWith(videoId) && (f.endsWith(".jpg") || f.endsWith(".webp"))
    );

    if (files.length > 0) {
      const downloadedFile = join(dir, files[0]);
      if (downloadedFile !== outputPath) {
        fs.renameSync(downloadedFile, outputPath);
      }
      return outputPath;
    }

    throw new Error(`Thumbnail download failed for ${videoUrl}`);
  } catch (error) {
    if (error?.message === "Cancelled") {
      throw error;
    }
    console.warn(`Warning: Could not download thumbnail: ${error.message}`);
    return null;
  }
}
