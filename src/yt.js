import fs from "fs";
import path from "path";
import { ensureDir, join } from "./util.js";
import { getYtDlpExecutable } from "./binaries.js";
import { spawnTracked } from "./spawnUtil.js";
import { classifyPipelineUrl, isYouTubeUrl } from "./urlPolicy.js";

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

/**
 * Single video/track flat JSON is the media dict itself; playlists return `{ entries: [...] }`.
 * @param {object} data
 * @param {string} playlistUrl
 */
function normalizeFlatPlaylistPayload(data, playlistUrl) {
  if (data == null || typeof data !== "object") {
    throw new Error(`Failed to fetch playlist: invalid response\nURL: ${playlistUrl}`);
  }
  if (Array.isArray(data.entries) && data.entries.length > 0) {
    return data;
  }
  // Empty playlist/set: top-level `id` is often the playlist id — do not treat as one track.
  if (data._type === "playlist") {
    return { ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
  }
  const url = typeof data.url === "string" ? data.url.trim() : "";
  const webpage = typeof data.webpage_url === "string" ? data.webpage_url.trim() : "";
  const id = data.id != null && String(data.id).trim() !== "" ? String(data.id).trim() : "";
  if (id || url || webpage) {
    return {
      ...data,
      entries: [
        {
          id: data.id,
          title: data.title,
          url: url || webpage || playlistUrl,
          webpage_url: webpage || url || playlistUrl,
          uploader: data.uploader,
          channel: data.channel,
          channel_id: data.channel_id,
          artist: data.artist,
          upload_date: data.upload_date,
          release_year: data.release_year
        }
      ]
    };
  }
  return { ...data, entries: [] };
}

/**
 * @param {string} playlistUrl
 * @param {string[]} [extraArgs]
 * @param {AbortSignal} [signal]
 */
export async function ytDlpJson(playlistUrl, extraArgs = [], signal) {
  const { site, mode } = classifyPipelineUrl(playlistUrl);
  const playlistScope = mode === "single" ? ["--no-playlist"] : ["--yes-playlist"];
  const youtubeArgs = site === "youtube" ? youtubeYtDlpArgs() : [];
  const args = [
    "--dump-single-json",
    ...playlistScope,
    "--flat-playlist",
    ...youtubeArgs,
    ...extraArgs,
    playlistUrl
  ];

  const yt = getYtDlpExecutable();
  try {
    const { stdout } = await spawnTracked(yt, args, { signal });
    const data = JSON.parse(stdout);
    if (data === null) {
      throw new Error(`Failed to fetch playlist: empty response\nURL: ${playlistUrl}`);
    }
    return normalizeFlatPlaylistPayload(data, playlistUrl);
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
  const { site, mode } = classifyPipelineUrl(videoUrl);
  const playlistScope = mode === "single" ? ["--no-playlist"] : [];
  const youtubeArgs = site === "youtube" ? youtubeYtDlpArgs() : [];
  const args = ["--dump-single-json", ...playlistScope, ...youtubeArgs, ...extraArgs, videoUrl];
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
  if (!isYouTubeUrl(videoUrl)) {
    return null;
  }

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
