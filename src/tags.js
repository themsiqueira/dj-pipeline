import fs from "fs";
import NodeID3 from "node-id3";
import { AUDIO_FORMAT, normalizeAudioFormat } from "./audioFormats.js";

/**
 * MP3 is tagged here with ID3; FLAC already carries Vorbis comments and the cover
 * picture written by ffmpeg during the encode pass.
 * @param {string} filePath
 * @param {object} meta
 * @param {string | null} coverJpgPath
 * @param {string} format
 */
export function writeAudioTags(filePath, meta, coverJpgPath = null, format = AUDIO_FORMAT.MP3) {
  if (normalizeAudioFormat(format) === AUDIO_FORMAT.FLAC) return;
  writeId3(filePath, meta, coverJpgPath);
}

export function writeId3(mp3Path, meta, coverJpgPath = null) {
  const tags = {
    title: meta.title ?? "",
    artist: meta.artist ?? meta.uploader ?? "",
    album: meta.album ?? meta.playlist_title ?? "",
    trackNumber: meta.trackNumber ? String(meta.trackNumber) : undefined,
    year: meta.year ? String(meta.year) : undefined,
    genre: meta.genre ?? "",
    comment: {
      language: "eng",
      text: meta.webpage_url ? `Source: ${meta.webpage_url}` : ""
    }
  };

  if (coverJpgPath && fs.existsSync(coverJpgPath)) {
    tags.image = coverJpgPath; // node-id3 accepts path
  }

  const ok = NodeID3.write(tags, mp3Path);
  if (!ok) throw new Error(`Failed to write ID3 tags: ${mp3Path}`);
}

