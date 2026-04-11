import path from "path";
import fs from "fs";
import crypto from "crypto";
import { ensureDir, writeJson, join } from "./util.js";
import { ytDlpJson, ytDlpVideoJson, buildVideoUrl, downloadThumbnail } from "./yt.js";
import { downloadBestAudio, loudnormTwoPassToMp3, makeOutputName } from "./audio.js";
import { writeId3 } from "./tags.js";
import { buildITunesLibraryXml, toFileUrl } from "./rekordboxXml.js";
import { writeFailureReportCsv, writeLastRunErrorArtifact } from "./csvReport.js";
import { assertYtdlpAndFfmpegAvailable } from "./toolCheck.js";
import { toPipelineError } from "./pipelineErrors.js";
import { killAllPipelineChildren } from "./pipelineChildren.js";
import { classifyPipelineUrl } from "./urlPolicy.js";

export { assertValidPipelineUrl } from "./urlPolicy.js";

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

/**
 * Flat playlist entries usually include title + uploader; full JSON adds upload_date, artist, etc.
 * @param {object} entry
 */
function flatEntryHasSufficientMetadata(entry) {
  const title = String(entry?.title ?? "").trim();
  const who = String(
    entry?.uploader ?? entry?.channel ?? entry?.channel_id ?? entry?.artist ?? ""
  ).trim();
  return title.length > 0 && who.length > 0;
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

    const { site } = classifyPipelineUrl(playlistUrl);
    const playlist = await ytDlpJson(playlistUrl, [], signal);
    const playlistTitle = playlist.title || "Import";

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
      const trackUrl = resolveTrackDownloadUrl(entry, site);
      if (!trackUrl) {
        const reason =
          "Playlist entry has no usable track URL (private/deleted or unsupported entry type).";
        const entryUrl =
          typeof entry?.url === "string" && /^https?:\/\//i.test(entry.url) ? entry.url : "";
        failures.push({
          index: i + 1,
          url: entryUrl || playlistUrl,
          title: String(entry?.title || "").trim() || "(unknown)",
          reason
        });
        log("");
        log(`[${i + 1}/${total}] ${entry?.title || "(no URL)"}`);
        log(`  Skipped: ${reason}`);
        if (typeof onProgress === "function") {
          onProgress({ current: i + 1, total, title: String(entry?.title || "").trim() });
        }
        await Promise.resolve();
        continue;
      }

      const stem = artifactStem(entry, trackUrl);
      let rowTitle = entry.title || "";

      log("");
      log(`[${i + 1}/${total}] ${rowTitle || trackUrl}`);
      if (typeof onProgress === "function") {
        onProgress({ current: i + 1, total, title: rowTitle });
      }

      try {
        if (signal.aborted) {
          throw new Error("Cancelled");
        }

        let v;
        if (flatEntryHasSufficientMetadata(entry)) {
          v = videoMetaFromFlatEntry(entry, trackUrl);
        } else {
          v = await ytDlpVideoJson(trackUrl, [], signal);
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
          const rawMetaPath = join(LOGS_DIR, `${stem}.json`);
          writeJson(rawMetaPath, v);
        }

        const thumbnailPath = join(THUMBNAILS_DIR, `${stem}.jpg`);
        let coverArtPath = null;
        try {
          const downloaded = await downloadThumbnail(trackUrl, thumbnailPath, signal);
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

        const tmpFile = await downloadBestAudio(trackUrl, TMP, signal);
        const outName = makeOutputName({
          title: meta.title,
          stableId: stem,
          usedBasenames: usedAudioBasenames
        });
        const outMp3 = join(AUDIO_DIR, outName);

        const loudnormLog = join(LOGS_DIR, `${stem}.loudnorm.json`);
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
        failures.push({ index: i + 1, url: trackUrl, title: rowTitle, reason });
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
