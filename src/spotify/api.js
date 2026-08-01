import { getSpotifyAccessToken, clearTokenCache } from "./auth.js";
import { pipelineError, PIPELINE_ERROR } from "../pipelineErrors.js";

const API_BASE = "https://api.spotify.com/v1";

/**
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function apiGet(path, signal) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw new Error("Cancelled");

    const token = await getSpotifyAccessToken(signal);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal
      });
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("Cancelled");
      throw pipelineError(
        PIPELINE_ERROR.SPOTIFY_API,
        `Spotify API error: request failed: ${err?.message || err}`
      );
    }

    if (res.status === 401 && attempt === 0) {
      clearTokenCache();
      continue;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      if (retryAfter > 30 || attempt >= 3) {
        throw pipelineError(
          PIPELINE_ERROR.SPOTIFY_API,
          `Spotify API error: rate limited (retry-after ${retryAfter}s)`
        );
      }
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (res.status === 404) {
      throw pipelineError(PIPELINE_ERROR.SPOTIFY_NOT_FOUND, `Spotify resource not found: ${path}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw pipelineError(
        PIPELINE_ERROR.SPOTIFY_API,
        `Spotify API error: ${res.status} ${res.statusText} ${path}: ${body}`
      );
    }

    return res.json();
  }
  throw pipelineError(PIPELINE_ERROR.SPOTIFY_API, `Spotify API error: too many retries for ${path}`);
}

/**
 * @param {string} id
 * @param {AbortSignal} [signal]
 */
export function getTrack(id, signal) {
  return apiGet(`/tracks/${encodeURIComponent(id)}`, signal);
}

/**
 * @param {string} id
 * @param {AbortSignal} [signal]
 */
export function getAlbum(id, signal) {
  return apiGet(`/albums/${encodeURIComponent(id)}`, signal);
}

/**
 * @param {string} id
 * @param {AbortSignal} [signal]
 */
export async function getAlbumTracks(id, signal) {
  const items = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const page = await apiGet(
      `/albums/${encodeURIComponent(id)}/tracks?limit=${limit}&offset=${offset}`,
      signal
    );
    if (Array.isArray(page?.items)) items.push(...page.items);
    if (!page?.next || !Array.isArray(page.items) || page.items.length < limit) break;
    offset += limit;
    if (offset > 10_000) break;
  }
  return items;
}

/**
 * @param {string} id
 * @param {AbortSignal} [signal]
 */
export async function getPlaylist(id, signal) {
  return apiGet(
    `/playlists/${encodeURIComponent(id)}?fields=${encodeURIComponent("name,owner(display_name)")}`,
    signal
  );
}

/**
 * @param {string} id
 * @param {AbortSignal} [signal]
 */
export async function getPlaylistTracks(id, signal) {
  const items = [];
  let offset = 0;
  const limit = 100;
  const fields =
    "items(track(id,name,duration_ms,track_number,external_urls,artists(name),album(name,release_date,images),is_local,type)),next";
  while (true) {
    const page = await apiGet(
      `/playlists/${encodeURIComponent(id)}/tracks?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`,
      signal
    );
    if (Array.isArray(page?.items)) items.push(...page.items);
    if (!page?.next || !Array.isArray(page.items) || page.items.length < limit) break;
    offset += limit;
    if (offset > 10_000) break;
  }
  return items;
}
