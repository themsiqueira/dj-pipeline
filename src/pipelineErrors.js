export const PIPELINE_ERROR = {
  INVALID_URL: "INVALID_URL",
  TOOLS_UNAVAILABLE: "TOOLS_UNAVAILABLE",
  PLAYLIST_FETCH: "PLAYLIST_FETCH",
  VIDEO_METADATA: "VIDEO_METADATA",
  GEO_RESTRICTED: "GEO_RESTRICTED",
  SPOTIFY_CREDENTIALS_MISSING: "SPOTIFY_CREDENTIALS_MISSING",
  SPOTIFY_API: "SPOTIFY_API",
  SPOTIFY_NOT_FOUND: "SPOTIFY_NOT_FOUND",
  YOUTUBE_SEARCH_NO_RESULT: "YOUTUBE_SEARCH_NO_RESULT",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN"
};

/**
 * Build an error that carries its classification, so rewording the message cannot
 * silently reclassify it to UNKNOWN.
 * @param {keyof typeof PIPELINE_ERROR} code
 * @param {string} message
 */
export function pipelineError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * yt-dlp wording for an IP-based regional block, across extractors. SoundCloud says
 * "not available from your location due to geo restriction"; YouTube blocks read
 * "The uploader has not made this video available in your country".
 */
const GEO_RESTRICTED_RE =
  /not available from your location|geo[- ]restrict|available in your country|blocked it in your country|not available in your location/i;

/**
 * @param {unknown} err a rejected spawn error, whose real text is in `stderr`
 * @returns {boolean}
 */
export function looksGeoRestricted(err) {
  if (!err) return false;
  const text = [err.message, err.stderr, err.stdout]
    .filter(Boolean)
    .map(String)
    .join("\n");
  return text !== "" && GEO_RESTRICTED_RE.test(text);
}

/**
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
export function toPipelineError(err) {
  const message = (err && typeof err === "object" && "message" in err && err.message != null
    ? String(err.message)
    : String(err || "Unknown error")
  ).trim() || "Unknown error";

  // Only accept codes we own: child processes attach OS codes like ENOENT to `code` too.
  const tagged = err && typeof err === "object" ? err.code : undefined;
  if (typeof tagged === "string" && Object.hasOwn(PIPELINE_ERROR, tagged)) {
    return { code: PIPELINE_ERROR[tagged], message };
  }

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

  // Before the prefix checks below: a geo block usually arrives wrapped in
  // "Failed to fetch playlist: ..." and is a different problem with a different fix.
  if (GEO_RESTRICTED_RE.test(message)) {
    return { code: PIPELINE_ERROR.GEO_RESTRICTED, message };
  }

  if (message.startsWith("Failed to fetch playlist:")) {
    return { code: PIPELINE_ERROR.PLAYLIST_FETCH, message };
  }

  if (message.startsWith("Failed to fetch video metadata:")) {
    return { code: PIPELINE_ERROR.VIDEO_METADATA, message };
  }

  if (message.startsWith("Spotify credentials missing:")) {
    return { code: PIPELINE_ERROR.SPOTIFY_CREDENTIALS_MISSING, message };
  }

  if (message.startsWith("Spotify resource not found:")) {
    return { code: PIPELINE_ERROR.SPOTIFY_NOT_FOUND, message };
  }

  if (message.startsWith("Spotify API error:")) {
    return { code: PIPELINE_ERROR.SPOTIFY_API, message };
  }

  if (message.startsWith("No YouTube result for:")) {
    return { code: PIPELINE_ERROR.YOUTUBE_SEARCH_NO_RESULT, message };
  }

  return { code: PIPELINE_ERROR.UNKNOWN, message };
}
