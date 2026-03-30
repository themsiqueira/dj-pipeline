import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { ensureDir, join } from "./util.js";
import { getYtDlpExecutable } from "./binaries.js";

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

export function ytDlpJson(playlistUrl, extraArgs = []) {
  // --flat-playlist gives fast listing; we then fetch each video json for richer tags if desired.
  const args = [
    "--dump-single-json",
    "--yes-playlist",
    "--flat-playlist",
    ...youtubeYtDlpArgs(),
    ...extraArgs,
    playlistUrl
  ];

  try {
    const out = execFileSync(getYtDlpExecutable(), args, { encoding: "utf-8" });
    return JSON.parse(out);
  } catch (error) {
    const errorMsg = error.stderr?.toString() || error.message || "Unknown error";
    throw new Error(`Failed to fetch playlist: ${errorMsg}\nURL: ${playlistUrl}`);
  }
}

export function ytDlpVideoJson(videoUrl, extraArgs = []) {
  const args = ["--dump-single-json", ...youtubeYtDlpArgs(), ...extraArgs, videoUrl];
  try {
    const out = execFileSync(getYtDlpExecutable(), args, { encoding: "utf-8" });
    return JSON.parse(out);
  } catch (error) {
    const errorMsg = error.stderr?.toString() || error.message || "Unknown error";
    throw new Error(`Failed to fetch video metadata: ${errorMsg}\nURL: ${videoUrl}`);
  }
}

export function buildVideoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function downloadThumbnail(videoUrl, outputPath) {
  ensureDir(path.dirname(outputPath));
  
  // Download thumbnail as JPG
  const args = [
    "--no-warnings",
    ...youtubeYtDlpArgs(),
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails", "jpg",
    "-o", outputPath.replace(/\.jpg$/, ""),
    videoUrl
  ];

  try {
    execFileSync(getYtDlpExecutable(), args, { encoding: "utf-8", stdio: "pipe" });
    
    // yt-dlp saves as {id}.jpg, find the actual file
    const dir = path.dirname(outputPath);
    const videoId = new URL(videoUrl).searchParams.get("v") ?? "";
    const files = fs.readdirSync(dir).filter(f => 
      f.startsWith(videoId) && (f.endsWith(".jpg") || f.endsWith(".webp"))
    );
    
    if (files.length > 0) {
      const downloadedFile = join(dir, files[0]);
      // If it's webp, we need to convert or use as-is (node-id3 can handle both)
      // For simplicity, rename to our target path
      if (downloadedFile !== outputPath) {
        fs.renameSync(downloadedFile, outputPath);
      }
      return outputPath;
    }
    
    throw new Error(`Thumbnail download failed for ${videoUrl}`);
  } catch (error) {
    // If thumbnail download fails, return null (optional feature)
    console.warn(`Warning: Could not download thumbnail: ${error.message}`);
    return null;
  }
}

