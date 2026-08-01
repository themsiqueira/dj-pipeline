import { getYtDlpExecutable } from "./binaries.js";
import { spawnTracked } from "./spawnUtil.js";
import { buildVideoUrl, youtubeYtDlpArgs, runYtDlp } from "./yt.js";
import { pipelineError, PIPELINE_ERROR } from "./pipelineErrors.js";
import { sourceNetworkArgs } from "./networkArgs.js";

/**
 * @typedef {{ artist?: string, title?: string, durationMs?: number }} SearchTarget
 */

/** A match this far from the known duration is a different edit, not the track. */
const DURATION_TOLERANCE = 0.4;

/**
 * How far the top result may sit from the known duration before it is worth paying for
 * a wider search. Deliberately much tighter than {@link DURATION_TOLERANCE}: a radio
 * edit of a 4:50 track runs 3:39, which is a 24% gap yet still the wrong file, and
 * "close enough to accept" is not the same question as "close enough not to look".
 */
const DURATION_ESCALATION = 0.12;

/**
 * @param {number} candidateSec
 * @param {number} targetSec 0 when the duration is unknown
 * @returns {number} relative distance, or 0 when nothing can be compared
 */
function durationDelta(candidateSec, targetSec) {
  if (!targetSec || !candidateSec) return 0;
  return Math.abs(candidateSec - targetSec) / targetSec;
}

/**
 * @param {{ duration: number }} top
 * @param {number} targetSec
 * @returns {boolean}
 */
export function needsWiderSearch(top, targetSec) {
  if (!targetSec || !top?.duration) return false;
  return durationDelta(top.duration, targetSec) > DURATION_ESCALATION;
}

/**
 * @param {{ duration: number }[]} results
 * @param {number} targetSec
 * @returns {object | null} the closest result within {@link DURATION_TOLERANCE}
 */
export function closestByDuration(results, targetSec) {
  const ranked = (Array.isArray(results) ? results : [])
    .map((r) => ({
      r,
      score: r?.duration ? durationDelta(r.duration, targetSec) : Number.POSITIVE_INFINITY
    }))
    .sort((a, b) => a.score - b.score);
  const best = ranked[0];
  return best && best.score <= DURATION_TOLERANCE ? best.r : null;
}

/**
 * @param {string} query
 * @param {number} n
 * @param {AbortSignal} [signal]
 */
async function ytSearch(query, n, signal) {
  const args = [
    "--dump-single-json",
    "--flat-playlist",
    ...sourceNetworkArgs(),
    "--default-search",
    `ytsearch${n}`,
    ...youtubeYtDlpArgs(),
    `ytsearch${n}:${query}`
  ];
  const yt = getYtDlpExecutable();
  // Through the shared limiter: search is a YouTube request like any other, and the
  // pool would otherwise fire one per worker on top of the downloads.
  const { stdout } = await runYtDlp(() => spawnTracked(yt, args, { signal }), {
    signal,
    what: "YouTube search"
  });
  const data = JSON.parse(stdout);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries
    .map((e) => {
      const id = e?.id ? String(e.id) : "";
      const url =
        typeof e?.url === "string" && /^https?:\/\//.test(e.url)
          ? e.url
          : id
          ? buildVideoUrl(id)
          : "";
      const duration = Number(e?.duration) || 0;
      const title = String(e?.title || "");
      return { id, url, duration, title };
    })
    .filter((e) => e.url);
}

/**
 * Search YouTube for a track described by artist/title/duration and return the best
 * match. One search when the top result's length already fits; otherwise a second,
 * wider search whose closest-by-duration result wins.
 *
 * @param {SearchTarget} target
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ youtubeUrl: string, youtubeId: string }>}
 */
export async function resolveSearchTargetToYouTube(target, signal) {
  const artist = String(target?.artist || "").trim();
  const title = String(target?.title || "").trim();
  if (!title) {
    throw pipelineError(
      PIPELINE_ERROR.YOUTUBE_SEARCH_NO_RESULT,
      "No YouTube result for: (missing title)"
    );
  }
  const query = artist ? `${artist} ${title}` : title;
  const targetSec = Math.round((Number(target?.durationMs) || 0) / 1000);

  let results;
  try {
    results = await ytSearch(query, 1, signal);
  } catch (err) {
    if (err?.message === "Cancelled") throw err;
    throw pipelineError(
      PIPELINE_ERROR.YOUTUBE_SEARCH_NO_RESULT,
      `No YouTube result for: ${query} (${err?.message || err})`
    );
  }

  if (results.length === 0) {
    throw pipelineError(PIPELINE_ERROR.YOUTUBE_SEARCH_NO_RESULT, `No YouTube result for: ${query}`);
  }

  const top = results[0];
  if (!needsWiderSearch(top, targetSec)) {
    return { youtubeUrl: top.url, youtubeId: top.id };
  }

  // Retry with broader search and pick closest by duration.
  let wider;
  try {
    wider = await ytSearch(query, 3, signal);
  } catch {
    wider = [];
  }
  const best = closestByDuration(wider, targetSec);
  // Nothing within tolerance — fall back to top result.
  return best
    ? { youtubeUrl: best.url, youtubeId: best.id }
    : { youtubeUrl: top.url, youtubeId: top.id };
}

/**
 * @param {object} entry must include _spotify with primaryArtist, title, durationMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ youtubeUrl: string, youtubeId: string }>}
 */
export function resolveSpotifyEntryToYouTube(entry, signal) {
  const sp = entry?._spotify || {};
  return resolveSearchTargetToYouTube(
    {
      artist: sp.primaryArtist || entry?.artist,
      title: sp.title || entry?.title,
      durationMs: sp.durationMs
    },
    signal
  );
}
