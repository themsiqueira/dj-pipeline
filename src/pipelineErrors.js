export const PIPELINE_ERROR = {
  INVALID_URL: "INVALID_URL",
  TOOLS_UNAVAILABLE: "TOOLS_UNAVAILABLE",
  PLAYLIST_FETCH: "PLAYLIST_FETCH",
  VIDEO_METADATA: "VIDEO_METADATA",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN"
};

/**
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
export function toPipelineError(err) {
  const message = (err && typeof err === "object" && "message" in err && err.message != null
    ? String(err.message)
    : String(err || "Unknown error")
  ).trim() || "Unknown error";

  if (message === "Cancelled") {
    return { code: PIPELINE_ERROR.CANCELLED, message };
  }

  if (
    message.startsWith("Invalid URL format:") ||
    message.startsWith("Invalid pipeline URL:") ||
    message === "Invalid YouTube URL" ||
    message.includes("Invalid YouTube URL")
  ) {
    return { code: PIPELINE_ERROR.INVALID_URL, message };
  }

  if (
    message.includes("yt-dlp not found") ||
    message.includes("yt-dlp is not installed") ||
    message.includes("yt-dlp check failed") ||
    message.includes("ffmpeg not found") ||
    message.includes("ffmpeg is not installed") ||
    message.includes("ffmpeg check failed")
  ) {
    return { code: PIPELINE_ERROR.TOOLS_UNAVAILABLE, message };
  }

  if (message.startsWith("Failed to fetch playlist:")) {
    return { code: PIPELINE_ERROR.PLAYLIST_FETCH, message };
  }

  if (message.startsWith("Failed to fetch video metadata:")) {
    return { code: PIPELINE_ERROR.VIDEO_METADATA, message };
  }

  return { code: PIPELINE_ERROR.UNKNOWN, message };
}
