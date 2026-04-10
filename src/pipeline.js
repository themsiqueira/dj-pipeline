import path from "path";
import fs from "fs";
import { ensureDir, writeJson, join } from "./util.js";
import { ytDlpJson, ytDlpVideoJson, buildVideoUrl, downloadThumbnail } from "./yt.js";
import { downloadBestAudio, loudnormTwoPassToMp3, makeOutputName } from "./audio.js";
import { writeId3 } from "./tags.js";
import { buildITunesLibraryXml, toFileUrl } from "./rekordboxXml.js";
import { writeFailureReportCsv, writeLastRunErrorArtifact } from "./csvReport.js";
import { assertYtdlpAndFfmpegAvailable } from "./toolCheck.js";
import { toPipelineError } from "./pipelineErrors.js";
import { killAllPipelineChildren } from "./pipelineChildren.js";

export function normalizePlaylistUrl(raw) {
  return String(raw)
    .replace(/\\/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function assertValidYouTubePlaylistUrl(playlistUrl) {
  try {
    const url = new URL(playlistUrl);
    if (!url.hostname.includes("youtube.com") && !url.hostname.includes("youtu.be")) {
      throw new Error("Invalid YouTube URL");
    }
  } catch {
    throw new Error(`Invalid URL format: ${playlistUrl}`);
  }
}

function isCancelledError(err, signal) {
  return signal.aborted || err?.message === "Cancelled";
}

/**
 * Flat playlist entries usually include title + uploader; full JSON adds upload_date, artist, etc.
 * @param {object} entry
 */
function flatEntryHasSufficientMetadata(entry) {
  const title = String(entry?.title ?? "").trim();
  const who = String(entry?.uploader ?? entry?.channel ?? entry?.channel_id ?? "").trim();
  return title.length > 0 && who.length > 0;
}

/**
 * @param {object} entry
 * @param {string} videoUrl
 */
function videoMetaFromFlatEntry(entry, videoUrl) {
  const uploader = entry.uploader || entry.channel || entry.channel_id || "Unknown";
  const artist = entry.artist || entry.creator || uploader;
  const uploadDate = entry.upload_date;
  const webpage =
    typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) ? entry.url : videoUrl;
  return {
    title: entry.title,
    uploader,
    artist,
    upload_date: uploadDate,
    release_year: entry.release_year,
    webpage_url: webpage
  };
}

/**
 * @param {object} opts
 * @param {string} opts.playlistUrl
 * @param {string} opts.outputRoot absolute or cwd-relative base folder (audio, logs, rekordbox, tmp under it)
 * @param {AbortSignal} opts.signal
 * @param {(line: string) => void} [opts.onLog]
 * @param {(p: { current: number, total: number, title: string }) => void} [opts.onProgress]
 * @returns {Promise<{ failures: { index: number, url: string, title: string, reason: string }[], successCount: number, totalCount: number, xmlPath: string | null, csvPath: string | null }>}
 */
export async function runPlaylist({ playlistUrl, outputRoot, signal, onLog, onProgress }) {
  const log = typeof onLog === "function" ? onLog : () => {};

  const OUT = path.resolve(outputRoot);
  const TMP = join(OUT, "tmp");
  const AUDIO_DIR = join(OUT, "audio");
  const LOGS_DIR = join(OUT, "logs");
  const RB_DIR = join(OUT, "rekordbox");
  const THUMBNAILS_DIR = join(OUT, "tmp", "thumbnails");

  ensureDir(OUT);
  ensureDir(TMP);
  ensureDir(AUDIO_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(RB_DIR);
  ensureDir(THUMBNAILS_DIR);

  const runCore = async () => {
    killAllPipelineChildren();
    assertYtdlpAndFfmpegAvailable();

    if (signal.aborted) {
      throw new Error("Cancelled");
    }

    const playlist = await ytDlpJson(playlistUrl, [], signal);
    const playlistTitle = playlist.title || "YouTube Playlist";

    log(`Playlist: ${playlistTitle}`);
    log(`Items: ${playlist.entries?.length ?? 0}`);

    const tracksForXml = [];
    const failures = [];
    let trackId = 1;
    const entries = playlist.entries ?? [];
    const total = entries.length;
    const saveRawMeta = process.env.YOUTUBE_DJ_SAVE_RAW_META === "1";
    const usedAudioBasenames = new Set();

    for (let i = 0; i < total; i++) {
      if (signal.aborted) {
        throw new Error("Cancelled");
      }

      const entry = entries[i];
      const videoId = entry.id;
      const videoUrl = buildVideoUrl(videoId);
      let rowTitle = entry.title || "";

      log("");
      log(`[${i + 1}/${total}] ${rowTitle || videoUrl}`);
      if (typeof onProgress === "function") {
        onProgress({ current: i + 1, total, title: rowTitle });
      }

      try {
        if (signal.aborted) {
          throw new Error("Cancelled");
        }

        let v;
        if (flatEntryHasSufficientMetadata(entry)) {
          v = videoMetaFromFlatEntry(entry, videoUrl);
        } else {
          v = await ytDlpVideoJson(videoUrl, [], signal);
          rowTitle = v.title || rowTitle;
        }

        const meta = {
          title: v.title,
          uploader: v.uploader,
          artist: v.artist || v.uploader,
          playlist_title: playlistTitle,
          trackNumber: i + 1,
          year: v.release_year || (v.upload_date ? String(v.upload_date).slice(0, 4) : undefined),
          webpage_url: v.webpage_url
        };

        if (saveRawMeta) {
          const rawMetaPath = join(LOGS_DIR, `${videoId}.json`);
          writeJson(rawMetaPath, v);
        }

        const thumbnailPath = join(THUMBNAILS_DIR, `${videoId}.jpg`);
        let coverArtPath = null;
        try {
          const downloaded = await downloadThumbnail(videoUrl, thumbnailPath, signal);
          if (downloaded && fs.existsSync(downloaded)) {
            coverArtPath = downloaded;
          }
        } catch (error) {
          if (error?.message === "Cancelled") throw error;
          log(`  Warning: Could not download thumbnail: ${error.message}`);
        }

        if (signal.aborted) {
          throw new Error("Cancelled");
        }

        const tmpFile = await downloadBestAudio(videoUrl, TMP, signal);
        const outName = makeOutputName({
          title: meta.title,
          videoId,
          usedBasenames: usedAudioBasenames
        });
        const outMp3 = join(AUDIO_DIR, outName);

        const loudnormLog = join(LOGS_DIR, `${videoId}.loudnorm.json`);
        await loudnormTwoPassToMp3(tmpFile, outMp3, loudnormLog, { i: -9, tp: -1.0, lra: 8 }, signal);

        writeId3(outMp3, meta, coverArtPath);

        tracksForXml.push({
          trackId: trackId++,
          title: meta.title,
          artist: meta.artist,
          album: meta.playlist_title,
          trackNumber: meta.trackNumber,
          location: toFileUrl(outMp3)
        });

        log(`Saved: ${outMp3}`);

        try {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
          if (coverArtPath && fs.existsSync(coverArtPath)) fs.unlinkSync(coverArtPath);
        } catch (error) {
          log(`  Warning: Could not clean up temp files: ${error.message}`);
        }
      } catch (err) {
        if (isCancelledError(err, signal)) {
          throw err;
        }
        const reason = (err?.message || String(err)).trim() || "Unknown error";
        failures.push({ index: i + 1, url: videoUrl, title: rowTitle, reason });
        log(`  Failed: ${reason}`);
      }

      await Promise.resolve();
    }

    let xmlPath = null;
    if (tracksForXml.length > 0) {
      xmlPath = join(RB_DIR, "iTunes Music Library.xml");
      const xml = buildITunesLibraryXml({
        tracks: tracksForXml,
        playlistName: playlistTitle,
        outputXmlPath: xmlPath
      });
      fs.writeFileSync(xmlPath, xml, "utf-8");

      log("");
      log(`Rekordbox XML written: ${xmlPath}`);
      log("Import in Rekordbox: File -> Import -> iTunes Library (XML)");
    } else {
      log("");
      log("No tracks were exported successfully; Rekordbox XML was not written.");
    }

    let csvPath = null;
    if (failures.length > 0) {
      const exportedAt = new Date().toISOString();
      csvPath = writeFailureReportCsv(join(OUT, "download_failures.csv"), failures, {
        playlistTitle,
        playlistUrl,
        exportedAt
      });
      log(`Failure report (CSV): ${csvPath}`);
    }

    return {
      failures,
      successCount: tracksForXml.length,
      totalCount: total,
      xmlPath,
      csvPath
    };
  };

  try {
    return await runCore();
  } catch (err) {
    if (isCancelledError(err, signal)) {
      throw err;
    }
    try {
      const { code, message } = toPipelineError(err);
      writeLastRunErrorArtifact(OUT, {
        message,
        code,
        at: new Date().toISOString()
      });
    } catch {
      /* ignore artifact write errors */
    }
    throw err;
  }
}
