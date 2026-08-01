/**
 * @typedef {"playlist" | "album" | "track"} SpotifyKind
 * @typedef {{ kind: SpotifyKind, id: string }} SpotifyRef
 */

const KINDS = new Set(["playlist", "album", "track"]);
const ID_RE = /^[A-Za-z0-9]{10,}$/;

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isSpotifyUrl(raw) {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (s.startsWith("spotify:")) return true;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return h === "open.spotify.com" || h === "play.spotify.com";
  } catch {
    return false;
  }
}

/**
 * Accepts:
 *  - https://open.spotify.com/{playlist|album|track}/{id}[?si=...]
 *  - https://open.spotify.com/intl-xx/{kind}/{id}
 *  - spotify:{kind}:{id}
 * @param {string} raw
 * @returns {SpotifyRef}
 */
export function parseSpotifyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error(`Invalid pipeline URL: empty Spotify URL`);

  if (s.startsWith("spotify:")) {
    const parts = s.split(":");
    if (parts.length >= 3) {
      const kind = parts[1].toLowerCase();
      const id = parts[2];
      if (KINDS.has(kind) && ID_RE.test(id)) {
        return { kind: /** @type {SpotifyKind} */ (kind), id };
      }
    }
    throw new Error(`Invalid pipeline URL: unrecognized Spotify URI: ${raw}`);
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`Invalid URL format: ${raw}`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== "open.spotify.com" && host !== "play.spotify.com") {
    throw new Error(`Invalid pipeline URL: not a Spotify URL: ${raw}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // Strip /intl-xx prefix.
  if (segments.length > 0 && /^intl(-[a-z]{2})?$/i.test(segments[0])) {
    segments.shift();
  }

  if (segments.length >= 2) {
    const kind = segments[0].toLowerCase();
    const id = segments[1];
    if (KINDS.has(kind) && ID_RE.test(id)) {
      return { kind: /** @type {SpotifyKind} */ (kind), id };
    }
  }

  throw new Error(`Invalid pipeline URL: unsupported Spotify path: ${raw}`);
}
