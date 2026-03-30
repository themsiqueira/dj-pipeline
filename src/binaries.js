/**
 * Override with absolute paths when bundling (Electron sets YOUTUBE_DJ_* before running the pipeline).
 * Defaults use tools on PATH.
 */
export function getYtDlpExecutable() {
  const v = process.env.YOUTUBE_DJ_YTDLP?.trim();
  return v || "yt-dlp";
}

export function getFfmpegExecutable() {
  const v = process.env.YOUTUBE_DJ_FFMPEG?.trim();
  return v || "ffmpeg";
}
