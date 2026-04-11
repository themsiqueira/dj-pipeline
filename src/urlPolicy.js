/**
 * @typedef {"youtube" | "soundcloud" | "unknown"} PipelineSite
 * @typedef {"playlist" | "single"} PipelineMode
 */

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
 * @param {string} rawUrl
 * @returns {{ site: PipelineSite, mode: PipelineMode }}
 */
export function classifyPipelineUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
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

  return { site, mode: "single" };
}

/**
 * @param {string} playlistUrl
 */
export function assertValidPipelineUrl(playlistUrl) {
  try {
    const url = new URL(playlistUrl);
    const site = siteFromHostname(url.hostname);
    if (site === "unknown") {
      throw new Error("Invalid pipeline URL: only YouTube and SoundCloud are supported.");
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.startsWith("Invalid pipeline URL:")) {
      throw e;
    }
    throw new Error(`Invalid URL format: ${playlistUrl}`);
  }
}
