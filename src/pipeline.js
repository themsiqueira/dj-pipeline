import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { ensureDir, writeJson, join, removeQuiet, emptyDirQuiet, fileSizeQuiet } from "./util.js";
import {
  ytDlpJson,
  buildVideoUrl,
  downloadTrackBundle,
  configureYtDlpConcurrency
} from "./yt.js";
import { loudnormTwoPassEncode, makeOutputName } from "./audio.js";
import { mapWithConcurrency } from "./concurrency.js";
import { normalizeAudioFormat } from "./audioFormats.js";
import { writeAudioTags } from "./tags.js";
import { buildRekordboxXml } from "./rekordboxDjPlaylists.js";
import { analyzeTracks, classifyTracks } from "./analysis/index.js";
import { applyAnalysisTags } from "./analysis/tagWriteback.js";
import { buildSetOrder } from "./setlist/order.js";
import { renderSetNotes } from "./setlist/notes.js";
import { enrichTransitions } from "./setlist/ai.js";
import { writeFailureReportCsv, writeLastRunErrorArtifact } from "./csvReport.js";
import { assertYtdlpAndFfmpegAvailable, assertFfmpegAvailable } from "./toolCheck.js";
import { loadLocalTracks } from "./localSource.js";
import { probeDurationQuiet } from "./mediaProbe.js";
import { toPipelineError, looksGeoRestricted, PIPELINE_ERROR } from "./pipelineErrors.js";
import { killAllPipelineChildren } from "./pipelineChildren.js";
import { classifyPipelineUrl } from "./urlPolicy.js";
import { fetchSoundCloudPageMeta } from "./soundcloudPage.js";
import { resolveProxy, redactProxyForLog } from "./networkArgs.js";
import { fetchSpotifyAsEntries } from "./spotify/fetchEntries.js";
import { resolveSpotifyEntryToYouTube, resolveSearchTargetToYouTube } from "./youtubeSearch.js";
import { downloadSpotifyCoverArt } from "./spotify/coverArt.js";

export { assertValidPipelineUrl } from "./urlPolicy.js";

/**
 * A run has several phases with independent counters. The renderer needs to tell
 * them apart, otherwise the progress bar appears to restart when analysis begins.
 */
export const PHASE = {
  DOWNLOAD: "download",
  /** Reading an existing library off disk: the local equivalent of DOWNLOAD. */
  SCAN: "scan",
  ANALYZE: "analyze",
  SET_ORDER: "setOrder"
};

export function normalizePlaylistUrl(raw) {
  return String(raw)
    .replace(/\\/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function isCancelledError(err, signal) {
  return signal.aborted || err?.message === "Cancelled";
}

function pickHttpsUrl(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return `https:${s}`;
  return "";
}

/**
 * @param {object} entry
 * @param {import("./urlPolicy.js").PipelineSite} site
 * @returns {string}
 */
function resolveTrackDownloadUrl(entry, site) {
  // A resolved YouTube stand-in wins whatever the source: a Spotify entry has no
  // downloadable page of its own, and a geo-blocked track is rescued the same way.
  const substitute = typeof entry?._youtubeUrl === "string" ? entry._youtubeUrl.trim() : "";
  if (substitute && /^https?:\/\//i.test(substitute)) {
    return substitute;
  }
  if (site === "spotify") {
    return "";
  }
  const candidates = [entry?.url, entry?.webpage_url, entry?.original_url];
  for (const c of candidates) {
    const abs = pickHttpsUrl(c);
    if (abs) return abs;
    if (typeof c === "string" && site === "soundcloud") {
      const t = c.trim();
      if (t.startsWith("/") && t.length > 1 && !t.startsWith("//")) {
        return `https://soundcloud.com${t}`;
      }
    }
  }
  const id = entry?.id != null && String(entry.id).trim() !== "" ? String(entry.id).trim() : "";
  if (site === "youtube" && id) {
    return buildVideoUrl(id);
  }
  return "";
}

/**
 * @param {object} entry
 * @param {string} trackUrl
 */
function artifactStem(entry, trackUrl) {
  const id = entry?.id != null ? String(entry.id).trim() : "";
  if (id && /^[a-zA-Z0-9._-]{1,80}$/.test(id)) {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  }
  return crypto.createHash("sha256").update(trackUrl).digest("hex").slice(0, 16);
}

/** Characters of an upload description kept for style classification. */
const DESCRIPTION_SCAN_LIMIT = 2000;

/**
 * The info.json written alongside the download: richer than a flat playlist entry
 * (upload_date, artist, release_year) and obtained without an extra yt-dlp launch.
 * @param {object} info
 * @param {string} trackUrl
 */
function videoMetaFromFullJson(info, trackUrl) {
  const uploader = info.uploader || info.channel || info.channel_id || "Unknown";
  return {
    title: String(info.title ?? "").trim() || "Unknown Title",
    uploader,
    artist: info.artist || info.creator || uploader,
    upload_date: info.upload_date,
    release_year: info.release_year,
    webpage_url: pickHttpsUrl(info.webpage_url) || trackUrl,
    // Rekordbox drops a track's cue points when TotalTime is missing, and it is
    // also the only duration available when the analysis phase is switched off.
    duration: Number(info.duration) || 0,
    // yt-dlp's own genre when the upload carries one, plus the free-text fields
    // that usually name the style ("melodic techno", "tech house"). Already
    // downloaded and parsed, so keeping them costs nothing.
    genre: info.genre || "",
    categories: Array.isArray(info.categories) ? info.categories : [],
    tags: Array.isArray(info.tags) ? info.tags : [],
    // Descriptions run to tens of kilobytes of links and timestamps, and every
    // track's metadata is held until the run ends. A style, when one is named at
    // all, is named at the top.
    description: String(info.description ?? "").slice(0, DESCRIPTION_SCAN_LIMIT)
  };
}

/**
 * @param {object} entry
 * @param {string} trackUrl
 */
function videoMetaFromFlatEntry(entry, trackUrl) {
  const uploader = entry.uploader || entry.channel || entry.channel_id || "Unknown";
  const artist = entry.artist || entry.creator || uploader;
  const uploadDate = entry.upload_date;
  const webpage = pickHttpsUrl(entry.url) || pickHttpsUrl(entry.webpage_url) || trackUrl;
  return {
    title: entry.title,
    uploader,
    artist,
    upload_date: uploadDate,
    release_year: entry.release_year,
    webpage_url: webpage,
    duration: Number(entry.duration) || 0
  };
}

/** A regional block is unfixable without a proxy, so a YouTube copy is tried instead. */
function geoFallbackEnabled() {
  return process.env.YOUTUBE_DJ_GEO_FALLBACK !== "0";
}

/**
 * What a YouTube search needs to find the same track. Duration matters most: it is
 * what tells the real track apart from a remix or an hour-long mix.
 * @param {object} entry
 * @returns {import("./youtubeSearch.js").SearchTarget}
 */
function searchTargetFromEntry(entry) {
  if (entry?._searchTarget) return entry._searchTarget;
  return {
    artist: entry?.artist || entry?.uploader || entry?.channel || "",
    title: entry?.title || "",
    durationMs: Math.round((Number(entry?.duration) || 0) * 1000)
  };
}

/**
 * Bounded by CPU because every track ends in two ffmpeg passes, and kept low because
 * the sources are shared: four parallel yt-dlp processes is already assertive.
 */
function resolveConcurrency() {
  const override = Number(process.env.YOUTUBE_DJ_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(8, Math.floor(override));
  }
  const cpus = os.cpus()?.length || 2;
  return Math.min(4, Math.max(1, Math.ceil(cpus / 2)));
}

/**
 * Everything needed to turn one playlist entry into one exported file. Extracted from
 * `runPlaylist` so the track loop can run as a pool rather than a sequential `for`.
 *
 * Never throws for a track-level failure: it returns a `failure` so one bad track
 * cannot take the run down. Cancellation is the one exception and propagates.
 *
 * @returns {Promise<{ track?: object, failure?: object }>}
 */
async function processTrack(entry, index, ctx) {
  const {
    site,
    signal,
    total,
    format,
    playlistUrl,
    playlistTitle,
    spotifyKind,
    saveRawMeta,
    usedAudioBasenames,
    dirs,
    log: runLog,
    reportStep,
    reportDone
  } = ctx;

  const position = index + 1;
  const lines = [];
  // Buffered and flushed together: with a pool running, interleaved per-line output
  // would be unreadable.
  const log = (line) => lines.push(line);
  const flush = () => {
    runLog("");
    for (const line of lines) runLog(line);
    lines.length = 0;
  };

  let rowTitle = String(entry?.title || "").trim();
  let trackUrl = "";
  let workDir = null;

  // Roughly where one track's time goes. Without these a single-track run shows
  // an empty bar for its whole length and then jumps straight to done.
  const step = (fraction) => reportStep(index, fraction, rowTitle);

  const fail = (reason, url) => {
    log(`  Failed: ${reason}`);
    return { failure: { index: position, url: url || playlistUrl, title: rowTitle || "(unknown)", reason } };
  };

  try {
    if (signal.aborted) throw new Error("Cancelled");
    log(`[${position}/${total}] ${rowTitle || "(track)"}`);

    if (site === "spotify" && !entry._youtubeUrl) {
      try {
        const { youtubeUrl } = await resolveSpotifyEntryToYouTube(entry, signal);
        entry._youtubeUrl = youtubeUrl;
        log(`  YouTube match: ${youtubeUrl}`);
      } catch (err) {
        if (isCancelledError(err, signal)) throw err;
        return fail((err?.message || String(err)).trim() || "Unknown error", entry?.webpage_url);
      }
    } else if (entry._geoFallback && !entry._youtubeUrl) {
      // Known blocked before we start, so the doomed yt-dlp launch is skipped.
      try {
        const { youtubeUrl } = await resolveSearchTargetToYouTube(
          searchTargetFromEntry(entry),
          signal
        );
        entry._youtubeUrl = youtubeUrl;
        log(`  Blocked in this region; using YouTube instead: ${youtubeUrl}`);
      } catch (err) {
        if (isCancelledError(err, signal)) throw err;
        return fail(
          "Geo-restricted: blocked in this region and no YouTube substitute was found " +
            `(${(err?.message || String(err)).trim()}). Set YOUTUBE_DJ_PROXY or use a VPN.`,
          entry?.webpage_url
        );
      }
    }

    trackUrl = resolveTrackDownloadUrl(entry, site);
    if (!trackUrl) {
      const reason =
        "Playlist entry has no usable track URL (private/deleted or unsupported entry type).";
      log(`  Skipped: ${reason}`);
      const entryUrl =
        typeof entry?.url === "string" && /^https?:\/\//i.test(entry.url) ? entry.url : "";
      return {
        failure: {
          index: position,
          url: entryUrl || entry?.webpage_url || playlistUrl,
          title: rowTitle || "(unknown)",
          reason
        }
      };
    }

    const stem = artifactStem(entry, trackUrl);
    // Index-suffixed: a playlist may legitimately list the same track twice, and two
    // workers sharing a scratch directory would overwrite each other.
    workDir = join(dirs.TMP, `${stem}-${position}`);
    await removeQuiet(workDir);

    // Spotify's own album art beats a YouTube video thumbnail, and it costs one plain
    // HTTP request rather than an extra yt-dlp launch.
    let coverArtPath = null;
    if (entry._spotify?.albumArtUrl) {
      ensureDir(workDir);
      try {
        const downloaded = await downloadSpotifyCoverArt(
          entry._spotify.albumArtUrl,
          join(workDir, "cover.jpg"),
          signal
        );
        if (downloaded && fs.existsSync(downloaded)) coverArtPath = downloaded;
      } catch (err) {
        if (isCancelledError(err, signal)) throw err;
        log(`  Warning: Could not download Spotify cover art: ${err.message}`);
      }
    }

    const download = () =>
      downloadTrackBundle(trackUrl, workDir, {
        signal,
        wantThumbnail: !coverArtPath,
        onLog: log
      });

    let bundle;
    let geoSubstituted = entry._geoFallback === true;
    try {
      bundle = await download();
    } catch (err) {
      if (isCancelledError(err, signal)) throw err;
      // Only worth trying once, and never for an entry that is already a YouTube
      // stand-in: searching again would return the same blocked video.
      if (!looksGeoRestricted(err) || !geoFallbackEnabled() || entry._youtubeUrl) throw err;

      log("  Blocked in this region; searching YouTube for the same track...");
      let youtubeUrl;
      try {
        ({ youtubeUrl } = await resolveSearchTargetToYouTube(searchTargetFromEntry(entry), signal));
      } catch (searchErr) {
        if (isCancelledError(searchErr, signal)) throw searchErr;
        throw new Error(
          "Geo-restricted: blocked in this region and no YouTube substitute was found " +
            `(${(searchErr?.message || String(searchErr)).trim()}). ` +
            "Set YOUTUBE_DJ_PROXY or use a VPN."
        );
      }
      entry._youtubeUrl = youtubeUrl;
      trackUrl = youtubeUrl;
      geoSubstituted = true;
      log(`  Downloading from YouTube instead: ${youtubeUrl}`);
      await removeQuiet(workDir);
      bundle = await download();
    }

    if (!coverArtPath && bundle.thumbnailPath) {
      coverArtPath = bundle.thumbnailPath;
    }

    // The download is the long pole: it waits on a remote server, where the
    // encode that follows is bounded by local CPU.
    step(0.6);

    if (signal.aborted) throw new Error("Cancelled");

    // The bundle's info.json is free, so it is preferred over the flat entry and there
    // is no longer a separate metadata fetch.
    const v = bundle.info
      ? videoMetaFromFullJson(bundle.info, trackUrl)
      : videoMetaFromFlatEntry(entry, trackUrl);
    rowTitle = v.title || rowTitle;

    if (entry._spotify) {
      const sp = entry._spotify;
      v.title = sp.title || v.title;
      v.artist = sp.artists || sp.primaryArtist || v.artist;
      v.uploader = sp.primaryArtist || v.uploader;
      v.release_year = sp.releaseDate ? String(sp.releaseDate).slice(0, 4) : v.release_year;
      v.webpage_url = entry.webpage_url || v.webpage_url;
      rowTitle = v.title || rowTitle;
    }

    if (geoSubstituted) {
      // The stand-in upload is titled "Artist - Track (Official Music Video)" and the
      // output filename comes from this, so the original listing wins.
      const target = searchTargetFromEntry(entry);
      if (target.title) v.title = target.title;
      if (target.artist) {
        v.artist = target.artist;
        v.uploader = target.artist;
      }
      rowTitle = v.title || rowTitle;
    }

    const albumForMeta = entry._spotify?.album || "";
    const meta = {
      title: v.title,
      uploader: v.uploader,
      artist: v.artist || v.uploader,
      playlist_title: spotifyKind === "album" && albumForMeta ? albumForMeta : playlistTitle,
      trackNumber: entry._spotify?.trackNumber || position,
      year: v.release_year || (v.upload_date ? String(v.upload_date).slice(0, 4) : undefined),
      webpage_url: v.webpage_url,
      genre: v.genre || "",
      durationSec: v.duration || Math.round((Number(entry._spotify?.durationMs) || 0) / 1000)
    };

    if (saveRawMeta && bundle.info) {
      writeJson(join(dirs.LOGS_DIR, `${stem}.json`), bundle.info);
    }

    // makeOutputName is synchronous, so the check-and-reserve against the shared set
    // cannot be interleaved by another worker.
    const outName = makeOutputName({
      title: meta.title,
      stableId: stem,
      usedBasenames: usedAudioBasenames,
      ext: format
    });
    const outFile = join(dirs.AUDIO_DIR, outName);

    await loudnormTwoPassEncode(
      bundle.audioPath,
      outFile,
      join(dirs.LOGS_DIR, `${stem}.loudnorm.json`),
      { i: -9, tp: -1.0, lra: 8 },
      signal,
      { format, coverPath: coverArtPath, meta, onLog: log }
    );
    step(0.95);

    writeAudioTags(outFile, meta, coverArtPath, format);
    log(`Saved: ${outFile}`);

    return {
      track: {
        title: meta.title,
        artist: meta.artist,
        album: meta.playlist_title,
        trackNumber: meta.trackNumber,
        year: meta.year,
        genre: meta.genre,
        durationSec: meta.durationSec,
        // The free text the style classifier reads. Kept apart from `meta`, which
        // is the tag-writing shape, so nothing here reaches ffmpeg by accident.
        styleHints: {
          title: v.title,
          uploader: v.uploader,
          genre: v.genre || "",
          tags: v.tags ?? [],
          description: v.description ?? ""
        },
        comment: meta.webpage_url ? `Source: ${meta.webpage_url}` : "",
        // The analysis phase runs after every track is done, by which point the
        // scratch directory is gone, so it needs the real path.
        filePath: outFile,
        stem,
        format,
        sizeBytes: fileSizeQuiet(outFile)
      }
    };
  } catch (err) {
    if (isCancelledError(err, signal)) throw err;
    return fail((err?.message || String(err)).trim() || "Unknown error", trackUrl);
  } finally {
    // Unconditional: previously scratch files survived every failure path and the
    // directory grew across runs.
    if (workDir) await removeQuiet(workDir);
    flush();
    reportDone(index, rowTitle);
  }
}

/**
 * Rekordbox discards a track's cue points when `TotalTime` is 0, so a length has
 * to come from somewhere even for a file the analysis could not read. Only the
 * gaps are probed: a downloaded track already has its duration from yt-dlp, and
 * an analysed one from the decode.
 *
 * @param {Array<object>} tracks
 * @param {{ signal?: AbortSignal, log: (line: string) => void }} options
 */
async function fillMissingDurations(tracks, { signal, log }) {
  const missing = tracks.filter((t) => !t.analysis?.durationSec && !t.durationSec && t.filePath);
  if (missing.length === 0) return;

  await mapWithConcurrency(missing, 4, async (track) => {
    if (signal?.aborted) throw new Error("Cancelled");
    track.durationSec = await probeDurationQuiet(track.filePath, { signal });
  });

  const stillMissing = missing.filter((t) => !t.durationSec).length;
  if (stillMissing > 0) {
    log(`  ${stillMissing} track(s) have no readable duration; Rekordbox may drop their cue points.`);
  }
}

/**
 * Everything that happens once the tracks exist and their audio is on disk:
 * analysis, style classification, tag write-back, set ordering, the Rekordbox XML
 * and the reports.
 *
 * Shared verbatim by the download and local-library paths. The only thing the two
 * disagree about is where the tracks came from, which is settled before this runs.
 *
 * @param {object} input
 * @returns {Promise<{ failures: object[], successCount: number, totalCount: number, xmlPath: string | null, csvPath: string | null, notesPath: string | null }>}
 */
async function finishRun({
  tracks,
  failures,
  totalCount,
  collectionName,
  sourceUrl,
  outDir,
  rekordboxDir,
  analyze,
  includeBeatgrid,
  setOrder,
  signal,
  log,
  report
}) {
  if (analyze && tracks.length > 0) {
    // Deliberately not fatal: a file that cannot be measured should still reach
    // the XML with its metadata, just without cues.
    try {
      await analyzeTracks(tracks, {
        signal,
        onLog: log,
        onProgress: ({ current, total: analysisTotal, title }) =>
          report({ phase: PHASE.ANALYZE, current, total: analysisTotal, title })
      });
      classifyTracks(tracks, { onLog: log });
      await applyAnalysisTags(tracks, { signal, log });
    } catch (err) {
      if (isCancelledError(err, signal)) throw err;
      log(`Analysis phase failed, continuing without it: ${err?.message ?? err}`);
    }
  }

  await fillMissingDurations(tracks, { signal, log });

  // The suggested order is an extra playlist beside the original, never a
  // replacement: the user asked for these tracks in this order, and a
  // suggestion that quietly overwrote that would be a worse tool.
  let extraPlaylists = [];
  let notesPath = null;

  if (setOrder && analyze && tracks.length > 1) {
    try {
      report({ phase: PHASE.SET_ORDER, current: 0, total: tracks.length, title: "" });
      const suggestion = buildSetOrder(tracks);

      const aiNotes = await enrichTransitions(suggestion.transitions, { signal, onLog: log });

      extraPlaylists = [{ name: `${collectionName} (suggested order)`, tracks: suggestion.tracks }];

      notesPath = join(outDir, "set-notes.md");
      fs.writeFileSync(
        notesPath,
        renderSetNotes({
          tracks: suggestion.tracks,
          transitions: suggestion.transitions,
          playlistName: collectionName,
          aiNotes
        }),
        "utf-8"
      );

      log("");
      log(`Suggested set order written: ${notesPath}`);
      report({ phase: PHASE.SET_ORDER, current: tracks.length, total: tracks.length, title: "" });
    } catch (err) {
      if (isCancelledError(err, signal)) throw err;
      // The downloads and the XML are the product; a set suggestion is a bonus
      // and must not be able to cost the run.
      log(`Set ordering failed, continuing without it: ${err?.message ?? err}`);
      extraPlaylists = [];
      notesPath = null;
    }
  }

  let xmlPath = null;
  if (tracks.length > 0) {
    xmlPath = join(rekordboxDir, "rekordbox.xml");
    const xml = buildRekordboxXml({
      tracks,
      playlistName: collectionName,
      outputXmlPath: xmlPath,
      includeBeatgrid,
      playlists: extraPlaylists
    });
    fs.writeFileSync(xmlPath, xml, "utf-8");

    log("");
    log(`Rekordbox XML written: ${xmlPath}`);
    if (extraPlaylists.length) {
      log(`Contains two playlists: "${collectionName}" and "${collectionName} (suggested order)".`);
    }
    log("In Rekordbox: Preferences > Advanced > Database > rekordbox xml > set this file,");
    log("then Preferences > View > Layout > tick 'rekordbox xml' to show the tree,");
    log("then right-click the tracks in that tree and choose 'Import to Collection'.");
  } else {
    log("");
    log("No tracks were exported successfully; Rekordbox XML was not written.");
  }

  let csvPath = null;
  if (failures.length > 0) {
    csvPath = writeFailureReportCsv(join(outDir, "download_failures.csv"), failures, {
      playlistTitle: collectionName,
      playlistUrl: sourceUrl,
      exportedAt: new Date().toISOString()
    });
    log(`Failure report (CSV): ${csvPath}`);
  }

  return {
    failures,
    successCount: tracks.length,
    totalCount,
    xmlPath,
    csvPath,
    notesPath
  };
}

/**
 * A geo-blocked single track cannot be enumerated by yt-dlp at all, but its public page
 * still names it, and that is enough to look for a copy on YouTube. A blocked `/sets/`
 * URL has no such shortcut — nothing can list its tracks — so that stays fatal.
 *
 * @param {string} playlistUrl
 * @param {import("./urlPolicy.js").PipelineSite} site
 * @param {import("./urlPolicy.js").PipelineMode} mode
 * @param {AbortSignal} signal
 * @param {(line: string) => void} log
 */
async function fetchNonSpotifyPlaylist(playlistUrl, site, mode, signal, log) {
  try {
    return await ytDlpJson(playlistUrl, [], signal);
  } catch (err) {
    if (err?.message === "Cancelled") throw err;
    const geo =
      looksGeoRestricted(err) || toPipelineError(err).code === PIPELINE_ERROR.GEO_RESTRICTED;
    if (!geo || !geoFallbackEnabled() || site !== "soundcloud" || mode !== "single") {
      throw err;
    }

    log("Blocked in this region; reading the track's public page instead...");
    const meta = await fetchSoundCloudPageMeta(playlistUrl, signal);
    if (!meta.title) throw err;
    log(`Found: ${meta.artist ? `${meta.artist} - ` : ""}${meta.title}`);

    return {
      title: meta.title,
      entries: [
        {
          title: meta.title,
          uploader: meta.artist,
          artist: meta.artist,
          duration: meta.durationMs ? meta.durationMs / 1000 : 0,
          webpage_url: playlistUrl,
          _searchTarget: meta,
          _geoFallback: true
        }
      ]
    };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.playlistUrl
 * @param {string} opts.outputRoot absolute or cwd-relative base folder (audio, logs, rekordbox, tmp under it)
 * @param {AbortSignal} opts.signal
 * @param {string} [opts.audioFormat] "mp3" (default) or "flac"
 * @param {boolean} [opts.analyze] measure BPM/key/energy and generate cue points
 * @param {boolean} [opts.includeBeatgrid] also write a TEMPO beatgrid into the XML
 * @param {(line: string) => void} [opts.onLog]
 * @param {(p: { phase: string, current: number, total: number, title: string }) => void} [opts.onProgress]
 * @returns {Promise<{ failures: { index: number, url: string, title: string, reason: string }[], successCount: number, totalCount: number, xmlPath: string | null, csvPath: string | null }>}
 */
export async function runPlaylist({
  playlistUrl,
  outputRoot,
  signal,
  audioFormat,
  analyze = false,
  includeBeatgrid = false,
  setOrder = false,
  onLog,
  onProgress
}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const format = normalizeAudioFormat(audioFormat);
  const report = (progress) => {
    if (typeof onProgress === "function") onProgress(progress);
  };

  const OUT = path.resolve(outputRoot);
  const TMP = join(OUT, "tmp");
  const AUDIO_DIR = join(OUT, "audio");
  const LOGS_DIR = join(OUT, "logs");
  const RB_DIR = join(OUT, "rekordbox");

  ensureDir(OUT);
  ensureDir(AUDIO_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(RB_DIR);

  const concurrency = resolveConcurrency();
  configureYtDlpConcurrency(concurrency);

  const runCore = async () => {
    killAllPipelineChildren();
    await assertYtdlpAndFfmpegAvailable();

    // Anything left in tmp/ is debris from a run that failed or was cancelled.
    await emptyDirQuiet(TMP);
    ensureDir(TMP);

    if (signal.aborted) {
      throw new Error("Cancelled");
    }

    const proxy = resolveProxy();
    if (proxy) {
      log(`Proxy: ${redactProxyForLog(proxy)}`);
    }

    const { site, mode } = classifyPipelineUrl(playlistUrl);
    const playlist =
      site === "spotify"
        ? await fetchSpotifyAsEntries(playlistUrl, signal, log)
        : await fetchNonSpotifyPlaylist(playlistUrl, site, mode, signal, log);
    const playlistTitle = playlist.title || "Import";
    const spotifyKind = playlist._spotifyKind;

    log(`Playlist: ${playlistTitle}`);
    log(`Items: ${playlist.entries?.length ?? 0}`);
    log(`Format: ${format.toUpperCase()}`);

    const entries = playlist.entries ?? [];
    const total = entries.length;
    const saveRawMeta = process.env.YOUTUBE_DJ_SAVE_RAW_META === "1";
    const usedAudioBasenames = new Set();

    let completed = 0;
    // Tracks in flight contribute a fraction each, so the reported position is
    // continuous rather than a step per finished track. With a pool running,
    // several are always partly done.
    /** @type {Map<number, number>} */
    const inFlight = new Map();
    const reportTrackProgress = (title) => {
      let partial = 0;
      for (const fraction of inFlight.values()) partial += fraction;
      report({
        phase: PHASE.DOWNLOAD,
        current: Math.min(total, completed + partial),
        total,
        title
      });
    };

    const ctx = {
      site,
      signal,
      total,
      format,
      playlistUrl,
      playlistTitle,
      spotifyKind,
      saveRawMeta,
      usedAudioBasenames,
      dirs: { TMP, AUDIO_DIR, LOGS_DIR },
      log,
      reportStep: (index, fraction, title) => {
        inFlight.set(index, fraction);
        reportTrackProgress(title);
      },
      reportDone: (index, title) => {
        inFlight.delete(index);
        completed += 1;
        reportTrackProgress(title);
      }
    };

    if (concurrency > 1 && total > 1) {
      log(`Processing ${Math.min(concurrency, total)} tracks at a time.`);
    }

    // Results stay in playlist order regardless of completion order, so the Rekordbox
    // XML and the failure CSV do not shuffle between runs.
    const results = await mapWithConcurrency(entries, concurrency, (entry, i) =>
      processTrack(entry, i, ctx)
    );

    const tracksForXml = [];
    const failures = [];
    let trackId = 1;
    for (const result of results) {
      if (result?.track) {
        tracksForXml.push({ trackId: trackId++, ...result.track });
      } else if (result?.failure) {
        failures.push(result.failure);
      }
    }

    return finishRun({
      tracks: tracksForXml,
      failures,
      totalCount: total,
      collectionName: playlistTitle,
      sourceUrl: playlistUrl,
      outDir: OUT,
      rekordboxDir: RB_DIR,
      analyze,
      includeBeatgrid,
      setOrder,
      signal,
      log,
      report
    });
  };

  try {
    return await runCore();
  } catch (err) {
    // Cancelling mid-download otherwise leaves partial media behind for every
    // in-flight track.
    await emptyDirQuiet(TMP);
    throw recordRunError(err, OUT, signal);
  }
}

/** Leaves a machine-readable trace of a fatal run error beside the output. */
function recordRunError(err, outDir, signal) {
  if (isCancelledError(err, signal)) return err;
  try {
    const { code, message } = toPipelineError(err);
    writeLastRunErrorArtifact(outDir, { message, code, at: new Date().toISOString() });
  } catch {
    /* ignore artifact write errors */
  }
  return err;
}

/**
 * Analyse a folder or single file the user already owns.
 *
 * The files are read where they are and written back to in place, so `outputRoot`
 * only ever receives the Rekordbox XML and the set notes. Nothing is copied,
 * converted or renamed: pointing this at a 200 GB library must not need 200 GB.
 *
 * Analysis is not optional here. Without it there is nothing to do — no download
 * to perform, no tags to improve — so the flag is not offered.
 *
 * @param {object} opts
 * @param {string} opts.inputPath folder or file to analyse
 * @param {string} opts.outputRoot where the XML and set notes are written
 * @param {AbortSignal} opts.signal
 * @param {boolean} [opts.includeBeatgrid] also write a TEMPO beatgrid into the XML
 * @param {boolean} [opts.setOrder] add a suggested running order and set notes
 * @param {(line: string) => void} [opts.onLog]
 * @param {(p: { phase: string, current: number, total: number, title: string }) => void} [opts.onProgress]
 * @returns {Promise<{ failures: object[], successCount: number, totalCount: number, xmlPath: string | null, csvPath: string | null, notesPath: string | null }>}
 */
export async function runLocalTracks({
  inputPath,
  outputRoot,
  signal,
  includeBeatgrid = false,
  setOrder = false,
  onLog,
  onProgress
}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const report = (progress) => {
    if (typeof onProgress === "function") onProgress(progress);
  };

  const OUT = path.resolve(outputRoot);
  const RB_DIR = join(OUT, "rekordbox");
  ensureDir(OUT);
  ensureDir(RB_DIR);

  try {
    killAllPipelineChildren();
    // yt-dlp is not involved, so a machine without it can still analyse a library.
    await assertFfmpegAvailable();
    if (signal.aborted) throw new Error("Cancelled");

    const { tracks, sourceName } = await loadLocalTracks({
      inputPath,
      signal,
      onLog: log,
      onProgress: ({ current, total, title }) =>
        report({ phase: PHASE.SCAN, current, total, title })
    });

    log("Files are analysed where they are; nothing is copied or re-encoded.");

    const tracksForXml = tracks.map((track, i) => ({ trackId: i + 1, ...track }));

    return await finishRun({
      tracks: tracksForXml,
      failures: [],
      totalCount: tracksForXml.length,
      collectionName: sourceName,
      sourceUrl: path.resolve(inputPath),
      outDir: OUT,
      rekordboxDir: RB_DIR,
      analyze: true,
      includeBeatgrid,
      setOrder,
      signal,
      log,
      report
    });
  } catch (err) {
    throw recordRunError(err, OUT, signal);
  }
}
