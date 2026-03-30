import fs from "fs";
import NodeID3 from "node-id3";

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

