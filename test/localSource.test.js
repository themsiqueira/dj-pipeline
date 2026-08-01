import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  scanAudioFiles,
  parseTrackFilename,
  isSupportedAudioFile,
  loadLocalTracks
} from "../src/localSource.js";

function makeLibrary(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytdj-lib-"));
  for (const [relative, contents] of Object.entries(layout)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents ?? "audio");
  }
  return root;
}

test("scans nested folders and ignores everything that is not playable audio", () => {
  const root = makeLibrary({
    "a.mp3": null,
    "notes.txt": null,
    "cover.jpg": null,
    "Techno/b.flac": null,
    "Techno/Peak Time/c.wav": null,
    "House/d.aiff": null,
    "House/e.opus": null
  });

  const found = scanAudioFiles(root).map((f) => path.relative(root, f));

  assert.deepEqual(found.sort(), ["House/d.aiff", "Techno/Peak Time/c.wav", "Techno/b.flac", "a.mp3"].sort());
});

test("hidden folders and macOS resource-fork stubs are skipped", () => {
  const root = makeLibrary({
    "real.mp3": null,
    "._real.mp3": null,
    ".Trash/deleted.mp3": null,
    ".hidden.flac": null
  });

  const found = scanAudioFiles(root).map((f) => path.basename(f));

  assert.deepEqual(found, ["real.mp3"], "a resource fork stub would otherwise double every track");
});

test("files sort numerically, not lexically", () => {
  const root = makeLibrary({ "track2.mp3": null, "track10.mp3": null, "track1.mp3": null });

  const found = scanAudioFiles(root).map((f) => path.basename(f));

  assert.deepEqual(found, ["track1.mp3", "track2.mp3", "track10.mp3"]);
});

test("a single file input yields just that file", () => {
  const root = makeLibrary({ "one.mp3": null, "two.mp3": null });

  assert.deepEqual(scanAudioFiles(path.join(root, "one.mp3")).map((f) => path.basename(f)), ["one.mp3"]);
  assert.deepEqual(scanAudioFiles(path.join(root, "one.mp3")).length, 1);
});

test("an unsupported single file yields nothing rather than throwing", () => {
  const root = makeLibrary({ "song.opus": null });

  assert.deepEqual(scanAudioFiles(path.join(root, "song.opus")), []);
});

test("extension matching is case-insensitive", () => {
  assert.equal(isSupportedAudioFile("/x/Track.MP3"), true);
  assert.equal(isSupportedAudioFile("/x/Track.FLAC"), true);
  assert.equal(isSupportedAudioFile("/x/Track.txt"), false);
});

test("filenames split into artist and title", () => {
  assert.deepEqual(parseTrackFilename("/x/Adam Beyer - Your Mind.mp3"), {
    artist: "Adam Beyer",
    title: "Your Mind"
  });
});

test("a leading track number is dropped", () => {
  assert.deepEqual(parseTrackFilename("/x/01 - Artist - Title.mp3"), { artist: "Artist", title: "Title" });
  assert.deepEqual(parseTrackFilename("/x/03. Artist - Title.flac"), { artist: "Artist", title: "Title" });
});

test("only the first separator splits, so a remix suffix stays in the title", () => {
  assert.deepEqual(parseTrackFilename("/x/Artist - Your Mind - Bart Skils Remix.mp3"), {
    artist: "Artist",
    title: "Your Mind - Bart Skils Remix"
  });
});

test("a hyphen without spaces is part of a name, not a separator", () => {
  assert.deepEqual(parseTrackFilename("/x/Jean-Michel Jarre.mp3"), {
    artist: "",
    title: "Jean-Michel Jarre"
  });
});

test("a nameless file still gets a title", () => {
  assert.equal(parseTrackFilename("/x/untitled.wav").title, "untitled");
});

test("loading a library produces pipeline tracks with folder and filename hints", async () => {
  const root = makeLibrary({ "Melodic Techno/Artist - Night Drive.mp3": null });

  const { tracks, sourceName } = await loadLocalTracks({ inputPath: root });

  assert.equal(tracks.length, 1);
  const [track] = tracks;
  assert.equal(track.title, "Night Drive");
  assert.equal(track.artist, "Artist");
  assert.equal(track.filePath, path.join(root, "Melodic Techno", "Artist - Night Drive.mp3"));
  assert.ok(track.styleHints.tags.includes("Melodic Techno"), "the folder name should reach the classifier");
  assert.ok(
    track.styleHints.tags.includes("Artist - Night Drive"),
    "the filename should reach the classifier too"
  );
  assert.equal(sourceName, path.basename(root));
});

test("an empty folder fails with a message naming the formats it looked for", async () => {
  const root = makeLibrary({ "readme.txt": null });

  await assert.rejects(() => loadLocalTracks({ inputPath: root }), /No supported audio files/);
});

test("a missing path fails clearly", async () => {
  await assert.rejects(() => loadLocalTracks({ inputPath: "/nope/does/not/exist" }), /Not found/);
});

test("progress is reported once per file", async () => {
  const root = makeLibrary({ "a.mp3": null, "b.mp3": null, "c.mp3": null });
  const seen = [];

  await loadLocalTracks({ inputPath: root, onProgress: (p) => seen.push(p) });

  assert.equal(seen.length, 3);
  assert.deepEqual(
    seen.map((p) => p.current),
    [1, 2, 3]
  );
  assert.ok(seen.every((p) => p.total === 3));
});
