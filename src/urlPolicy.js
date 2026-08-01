import { pipelineError, PIPELINE_ERROR } from "./pipelineErrors.js";

/**
 * @typedef {"youtube" | "soundcloud" | "spotify" | "unknown"} PipelineSite
 * @typedef {"playlist" | "single"} PipelineMode
 */

const SPOTIFY_URI_RE = /^spotify:(playlist|album|track):[A-Za-z0-9]{10,}$/i;

/**
 * @param {string} hostname
 * @returns {PipelineSite}
 */
export function siteFromHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "youtu.be" || h.endsWith("youtube.com") || h.endsWith("youtube-nocookie.com")) {
    return "youtube";
  }
  if (h.endsWith("soundcloud.com")) {
    return "soundcloud";
  }
  if (h === "open.spotify.com" || h === "play.spotify.com") {
    return "spotify";
  }
  return "unknown";
}

/**
 * @param {string} urlString
 * @returns {boolean}
 */
export function isYouTubeUrl(urlString) {
  try {
    return siteFromHostname(new URL(urlString).hostname) === "youtube";
  } catch {
    return false;
  }
}

/**
 * @param {string} urlString
 * @returns {boolean}
 */
export function isSpotifyPipelineUrl(urlString) {
  if (typeof urlString !== "string") return false;
  const s = urlString.trim();
  if (SPOTIFY_URI_RE.test(s)) return true;
  try {
    return siteFromHostname(new URL(s).hostname) === "spotify";
  } catch {
    return false;
  }
}

/**
 * @param {string} rawUrl
 * @returns {{ site: PipelineSite, mode: PipelineMode }}
 */
export function classifyPipelineUrl(rawUrl) {
  const raw = typeof rawUrl === "string" ? rawUrl.trim() : "";

  // spotify: URI form (not a valid URL() input).
  if (SPOTIFY_URI_RE.test(raw)) {
    const kind = raw.split(":")[1].toLowerCase();
    const mode = kind === "track" ? "single" : "playlist";
    return { site: "spotify", mode };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { site: "unknown", mode: "single" };
  }

  const site = siteFromHostname(url.hostname);
  if (site === "unknown") {
    return { site, mode: "single" };
  }

  if (site === "youtube") {
    if (url.hostname === "youtu.be" || url.pathname.startsWith("/shorts/")) {
      return { site, mode: "single" };
    }
    if (url.pathname === "/playlist" && url.searchParams.get("list")) {
      return { site, mode: "playlist" };
    }
    if (url.searchParams.get("v")) {
      return { site, mode: "single" };
    }
    return { site, mode: "single" };
  }

  if (site === "soundcloud") {
    if (url.pathname.includes("/sets/")) {
      return { site, mode: "playlist" };
    }
    return { site, mode: "single" };
  }

  if (site === "spotify") {
    // Strip /intl-xx prefix when classifying.
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length > 0 && /^intl(-[a-z]{2})?$/i.test(segments[0])) {
      segments.shift();
    }
    const kind = (segments[0] || "").toLowerCase();
    if (kind === "track") return { site, mode: "single" };
    if (kind === "playlist" || kind === "album") return { site, mode: "playlist" };
    return { site, mode: "single" };
  }

  return { site, mode: "single" };
}

/**
 * @param {string} playlistUrl
 */
export function assertValidPipelineUrl(playlistUrl) {
  const raw = typeof playlistUrl === "string" ? playlistUrl.trim() : "";
  if (SPOTIFY_URI_RE.test(raw)) return;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw pipelineError(PIPELINE_ERROR.INVALID_URL, `Invalid URL format: ${playlistUrl}`);
  }

  if (siteFromHostname(url.hostname) === "unknown") {
    throw pipelineError(
      PIPELINE_ERROR.INVALID_URL,
      "Invalid pipeline URL: only YouTube, SoundCloud, and Spotify are supported."
    );
  }
}
