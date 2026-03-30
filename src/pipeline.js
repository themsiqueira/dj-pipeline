import path from "path";
import fs from "fs";
import { ensureDir, writeJson, join } from "./util.js";
import { ytDlpJson, ytDlpVideoJson, buildVideoUrl, downloadThumbnail } from "./yt.js";
import { downloadBestAudio, loudnormTwoPassToMp3, makeOutputName } from "./audio.js";
import { writeId3 } from "./tags.js";
import { buildITunesLibraryXml, toFileUrl } from "./rekordboxXml.js";

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

/**
 * @param {object} opts
 * @param {string} opts.playlistUrl
 * @param {string} opts.outputRoot absolute or cwd-relative base folder (audio, logs, rekordbox, tmp under it)
 * @param {AbortSignal} opts.signal
 * @param {(line: string) => void} [opts.onLog]
 * @param {(p: { current: number, total: number, title: string }) => void} [opts.onProgress]
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

  if (signal.aborted) {
    throw new Error("Cancelled");
  }

  const playlist = ytDlpJson(playlistUrl);
  const playlistTitle = playlist.title || "YouTube Playlist";

  log(`Playlist: ${playlistTitle}`);
  log(`Items: ${playlist.entries?.length ?? 0}`);

  const tracksForXml = [];
  let trackId = 1;
  const entries = playlist.entries ?? [];
  const total = entries.length;

  for (let i = 0; i < total; i++) {
    if (signal.aborted) {
      throw new Error("Cancelled");
    }

    const entry = entries[i];
    const videoId = entry.id;
    const videoUrl = buildVideoUrl(videoId);

    log("");
    log(`[${i + 1}/${total}] ${entry.title}`);
    if (typeof onProgress === "function") {
      onProgress({ current: i + 1, total, title: entry.title || "" });
    }

    const v = ytDlpVideoJson(videoUrl);

    const meta = {
      title: v.title,
      uploader: v.uploader,
      artist: v.artist || v.uploader,
      playlist_title: playlistTitle,
      trackNumber: i + 1,
      year: v.release_year || (v.upload_date ? v.upload_date.slice(0, 4) : undefined),
      webpage_url: v.webpage_url
    };

    const rawMetaPath = join(LOGS_DIR, `${videoId}.json`);
    writeJson(rawMetaPath, v);

    const thumbnailPath = join(THUMBNAILS_DIR, `${videoId}.jpg`);
    let coverArtPath = null;
    try {
      const downloaded = downloadThumbnail(videoUrl, thumbnailPath);
      if (downloaded && fs.existsSync(downloaded)) {
        coverArtPath = downloaded;
      }
    } catch (error) {
      log(`  Warning: Could not download thumbnail: ${error.message}`);
    }

    if (signal.aborted) {
      throw new Error("Cancelled");
    }

    const tmpFile = downloadBestAudio(videoUrl, TMP);
    const outName = makeOutputName({ index: i + 1, title: meta.title });
    const outMp3 = join(AUDIO_DIR, outName);

    const loudnormLog = join(LOGS_DIR, `${videoId}.loudnorm.json`);
    loudnormTwoPassToMp3(tmpFile, outMp3, loudnormLog, { i: -9, tp: -1.0, lra: 8 });

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

    await Promise.resolve();
  }

  const xmlPath = join(RB_DIR, "iTunes Music Library.xml");
  const xml = buildITunesLibraryXml({
    tracks: tracksForXml,
    playlistName: playlistTitle,
    outputXmlPath: xmlPath
  });
  fs.writeFileSync(xmlPath, xml, "utf-8");

  log("");
  log(`Rekordbox XML written: ${xmlPath}`);
  log("Import in Rekordbox: File -> Import -> iTunes Library (XML)");
}
