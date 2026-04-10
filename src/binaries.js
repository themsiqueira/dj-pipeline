/**
 * Override with absolute paths when bundling (Electron sets YOUTUBE_DJ_* before running the pipeline).
 * Defaults use tools on PATH. Windows needs .exe for typical PATH lookups when not using a shell.
 */
export function getYtDlpExecutable() {
  const v = process.env.YOUTUBE_DJ_YTDLP?.trim();
  if (v) return v;
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

export function getFfmpegExecutable() {
  const v = process.env.YOUTUBE_DJ_FFMPEG?.trim();
  if (v) return v;
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}
