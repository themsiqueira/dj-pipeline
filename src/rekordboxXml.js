import path from "path";
import { create } from "xmlbuilder2";
import { ensureDir } from "./util.js";

export function buildITunesLibraryXml({ tracks, playlistName, outputXmlPath }) {
  ensureDir(path.dirname(outputXmlPath));

  // Minimal iTunes Music Library.xml (plist) structure
  // Rekordbox mainly needs: Track ID, Location (file://), Name/Artist/Album, Total Time (ms) optional.
  const plist = create({ version: "1.0", encoding: "UTF-8" })
    .dtd({
      pubID: "-//Apple//DTD PLIST 1.0//EN",
      sysID: "http://www.apple.com/DTDs/PropertyList-1.0.dtd"
    })
    .ele("plist", { version: "1.0" });

  const dict = plist.ele("dict");
  dict.ele("key").txt("Major Version").up().ele("integer").txt("1").up();
  dict.ele("key").txt("Minor Version").up().ele("integer").txt("1").up();

  // Tracks dictionary
  dict.ele("key").txt("Tracks").up();
  const tracksDict = dict.ele("dict");

  for (const t of tracks) {
    tracksDict.ele("key").txt(String(t.trackId)).up();
    const td = tracksDict.ele("dict");

    td.ele("key").txt("Track ID").up().ele("integer").txt(String(t.trackId)).up();
    td.ele("key").txt("Name").up().ele("string").txt(t.title || "").up();
    td.ele("key").txt("Artist").up().ele("string").txt(t.artist || "").up();
    td.ele("key").txt("Album").up().ele("string").txt(t.album || "").up();
    td.ele("key").txt("Track Number").up().ele("integer").txt(String(t.trackNumber || 0)).up();
    td.ele("key").txt("Location").up().ele("string").txt(t.location).up();

    if (t.totalTimeMs) {
      td.ele("key").txt("Total Time").up().ele("integer").txt(String(t.totalTimeMs)).up();
    }
  }

  // Playlists
  dict.ele("key").txt("Playlists").up();
  const playlistsArr = dict.ele("array");

  const pDict = playlistsArr.ele("dict");
  pDict.ele("key").txt("Name").up().ele("string").txt(playlistName).up();
  pDict.ele("key").txt("Playlist Items").up();
  const itemsArr = pDict.ele("array");
  for (const t of tracks) {
    const item = itemsArr.ele("dict");
    item.ele("key").txt("Track ID").up().ele("integer").txt(String(t.trackId)).up();
  }

  const xml = plist.end({ prettyPrint: true });
  return xml;
}

export function toFileUrl(filePath) {
  // iTunes XML uses file://localhost/ style URLs; keep it simple:
  const abs = path.resolve(filePath).split(path.sep).join("/");
  return `file://${abs.startsWith("/") ? "" : "/"}${abs}`;
}

