import { parseSpotifyUrl } from "./urlParse.js";
import { pipelineError, PIPELINE_ERROR } from "../pipelineErrors.js";
import {
  getTrack,
  getAlbum,
  getAlbumTracks,
  getPlaylist,
  getPlaylistTracks
} from "./api.js";

/**
 * @param {string} date release_date like "2023-06-15", "2023-06", or "2023"
 * @returns {string | undefined}
 */
function parseYear(date) {
  if (typeof date !== "string") return undefined;
  const m = date.match(/^(\d{4})/);
  return m ? m[1] : undefined;
}

/**
 * @param {any[] | undefined} artists
 * @returns {string}
 */
function primaryArtist(artists) {
  if (!Array.isArray(artists) || artists.length === 0) return "Unknown";
  return String(artists[0]?.name || "Unknown");
}

/**
 * @param {any[] | undefined} artists
 * @returns {string}
 */
function joinArtists(artists) {
  if (!Array.isArray(artists)) return "";
  return artists.map((a) => String(a?.name || "")).filter(Boolean).join(", ");
}

/**
 * @param {any[] | undefined} images
 * @returns {string | undefined}
 */
function pickAlbumArt(images) {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  // Spotify returns largest first.
  const biggest = images[0];
  return typeof biggest?.url === "string" ? biggest.url : undefined;
}

/**
 * Build a pipeline entry that mimics yt-dlp's flat-playlist shape.
 * @param {any} track
 * @param {any} albumFallback
 */
function shapeEntry(track, albumFallback) {
  const album = track?.album || albumFallback || {};
  const artist = primaryArtist(track?.artists);
  const artistsAll = joinArtists(track?.artists);
  const releaseDate = typeof album?.release_date === "string" ? album.release_date : undefined;
  const albumArtUrl = pickAlbumArt(album?.images);
  const webpage =
    (track?.external_urls && typeof track.external_urls.spotify === "string"
      ? track.external_urls.spotify
      : "") || (track?.id ? `https://open.spotify.com/track/${track.id}` : "");

  return {
    id: track?.id ? `sp_${track.id}` : undefined,
    title: String(track?.name || "").trim() || "Untitled",
    uploader: artist,
    artist,
    release_year: parseYear(releaseDate),
    webpage_url: webpage,
    url: null,
    _spotify: {
      trackId: track?.id || "",
      title: String(track?.name || "").trim(),
      artists: artistsAll || artist,
      primaryArtist: artist,
      album: String(album?.name || "").trim(),
      albumArtUrl,
      durationMs: Number(track?.duration_ms) || 0,
      trackNumber: Number(track?.track_number) || 0,
      releaseDate: releaseDate || ""
    }
  };
}

/**
 * @param {any} track
 */
function isUsableTrack(track) {
  if (!track || typeof track !== "object") return false;
  if (track.is_local) return false;
  if (track.type && track.type !== "track") return false;
  if (!track.id) return false;
  if (!track.name) return false;
  return true;
}

/**
 * @param {string} rawUrl
 * @param {AbortSignal} [signal]
 * @param {(line: string) => void} [onLog]
 * @returns {Promise<{ title: string, entries: any[], _spotifyKind: "playlist"|"album"|"track" }>}
 */
export async function fetchSpotifyAsEntries(rawUrl, signal, onLog) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const { kind, id } = parseSpotifyUrl(rawUrl);

  if (kind === "track") {
    const track = await getTrack(id, signal);
    if (!isUsableTrack(track)) {
      throw pipelineError(PIPELINE_ERROR.SPOTIFY_NOT_FOUND, `Spotify resource not found: track ${id}`);
    }
    return {
      title: String(track?.name || "Spotify Track"),
      entries: [shapeEntry(track, track?.album)],
      _spotifyKind: "track"
    };
  }

  if (kind === "album") {
    const album = await getAlbum(id, signal);
    if (!album?.id) {
      throw pipelineError(PIPELINE_ERROR.SPOTIFY_NOT_FOUND, `Spotify resource not found: album ${id}`);
    }
    log(`Spotify album: ${album.name}`);
    // /albums/{id} already embeds a tracks page; fetch the rest if needed.
    const firstItems = Array.isArray(album?.tracks?.items) ? album.tracks.items : [];
    const hasMore = Boolean(album?.tracks?.next);
    const items = hasMore ? await getAlbumTracks(id, signal) : firstItems;
    const entries = items
      .filter(isUsableTrack)
      .map((t) => shapeEntry(t, album));
    return { title: String(album?.name || "Spotify Album"), entries, _spotifyKind: "album" };
  }

  // playlist
  const [meta, items] = await Promise.all([
    getPlaylist(id, signal),
    getPlaylistTracks(id, signal)
  ]);
  log(`Spotify playlist: ${meta?.name || id}`);
  const entries = items
    .map((it) => it?.track)
    .filter(isUsableTrack)
    .map((t) => shapeEntry(t, t?.album));
  return {
    title: String(meta?.name || "Spotify Playlist"),
    entries,
    _spotifyKind: "playlist"
  };
}
