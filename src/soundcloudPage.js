/**
 * Reading a SoundCloud track page without yt-dlp.
 *
 * A geo-blocked track fails at the API level, but the public page still carries the
 * title, the artist and the duration. That is exactly what a YouTube search needs, so
 * a blocked single track can still be rescued instead of failing the whole run.
 */

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'"
};

/**
 * @param {string} s
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .trim();
}

/**
 * @param {string} html
 * @param {string} property value of the `property` or `name` attribute
 * @returns {string}
 */
function metaContent(html, property) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : "";
}

/**
 * Last resort when the page cannot be read at all: the track slug is a usable search
 * query. The user slug is not — "thechemicalbrothers" cannot be split back into words.
 * @param {string} pageUrl
 * @returns {{ title: string, artist: string, durationMs: number }}
 */
export function metaFromSoundCloudUrl(pageUrl) {
  let segments = [];
  try {
    segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
  } catch {
    segments = [];
  }
  const slug = segments.length >= 2 ? segments[1] : segments[0] || "";
  const title = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
  return { title, artist: "", durationMs: 0 };
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ title: string, artist: string, durationMs: number }}
 */
export function parseSoundCloudPageMeta(html, pageUrl) {
  const text = String(html || "");
  const fromUrl = metaFromSoundCloudUrl(pageUrl);

  const title = metaContent(text, "og:title") || fromUrl.title;

  // "Listen to Hey Boy Hey Girl by The Chemical Brothers #np on #SoundCloud"
  const description = metaContent(text, "og:description");
  let artist = "";
  const byMatch = /\bby\s+(.+?)(?:\s+#|\s+on\s+#SoundCloud|$)/i.exec(description);
  if (byMatch) {
    artist = byMatch[1].trim();
  }
  if (!artist) {
    // The hydration payload names the uploader even when the track itself is blocked.
    const username = /"username"\s*:\s*"([^"]+)"/.exec(text);
    if (username) artist = decodeEntities(username[1]);
  }

  // full_duration is the untruncated length; `duration` can be a 30 s preview.
  const durationMatch =
    /"full_duration"\s*:\s*(\d+)/.exec(text) || /"duration"\s*:\s*(\d+)/.exec(text);
  const durationMs = durationMatch ? Number(durationMatch[1]) : 0;

  return { title, artist, durationMs };
}

/**
 * Never throws for a network or parse problem: the caller is already handling a
 * failure and a slug-derived title is better than nothing. Cancellation propagates.
 *
 * Note this request does not honour YOUTUBE_DJ_PROXY: Node's fetch has no public
 * proxy support, and with a working proxy yt-dlp would not have failed in the first
 * place.
 *
 * @param {string} pageUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ title: string, artist: string, durationMs: number }>}
 */
export async function fetchSoundCloudPageMeta(pageUrl, signal) {
  let html = "";
  try {
    const res = await fetch(pageUrl, {
      signal,
      headers: {
        // The bare fetch UA gets a stripped-down page without the og: tags.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html"
      }
    });
    if (res.ok) html = await res.text();
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) throw new Error("Cancelled");
    html = "";
  }
  return parseSoundCloudPageMeta(html, pageUrl);
}
