import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { applyAnalysisTags } from "../src/analysis/tagWriteback.js";

/**
 * These guard a destructive path. Local sources are analysed in place, so a
 * wrong branch here does not fail a run, it edits files the user already owns.
 */

const ANALYSIS = { bpm: 128, keyClassical: "A minor", camelot: "8A", energyLevel: 7 };
const STYLE = { style: "melodic techno" };

/** Contents are irrelevant; only whether the bytes survive the call matters. */
function makeFile(ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdj-tags-"));
  const file = path.join(dir, `track${ext}`);
  fs.writeFileSync(file, "placeholder audio bytes");
  return file;
}

test("formats without ID3 or Vorbis tags are left byte-for-byte alone", async () => {
  const files = [".wav", ".aiff", ".aif", ".m4a", ".ogg"].map(makeFile);
  const before = files.map((f) => fs.readFileSync(f));
  const tracks = files.map((filePath) => ({ title: path.basename(filePath), filePath, analysis: ANALYSIS, style: STYLE }));

  await applyAnalysisTags(tracks, {});

  for (const [i, file] of files.entries()) {
    assert.deepEqual(fs.readFileSync(file), before[i], `${path.extname(file)} should not have been written to`);
  }
});

test("skipped files are reported once per format, not once per file", async () => {
  const tracks = Array.from({ length: 5 }, () => makeFile(".wav")).map((filePath) => ({
    title: "Some track",
    filePath,
    analysis: ANALYSIS
  }));
  const lines = [];

  await applyAnalysisTags(tracks, { log: (l) => lines.push(l) });

  const mentions = lines.filter((l) => l.includes(".wav"));
  assert.equal(mentions.length, 1, "a library of WAVs should not produce one warning per file");
  assert.match(mentions[0], /5 \.wav files/);
  assert.match(mentions[0], /XML/, "the note should say where the values did land");
});

test("MP3 still gets tagged", async () => {
  const file = makeFile(".mp3");
  const before = fs.readFileSync(file);

  await applyAnalysisTags([{ title: "Tagged", filePath: file, analysis: ANALYSIS, style: STYLE }], {});

  const after = fs.readFileSync(file);
  assert.notDeepEqual(after, before, "the MP3 branch should have written ID3 frames");
  assert.equal(after.subarray(0, 3).toString("latin1"), "ID3");
});

test("a track with neither analysis nor style is not touched at all", async () => {
  const file = makeFile(".mp3");
  const before = fs.readFileSync(file);

  await applyAnalysisTags([{ title: "Unanalysed", filePath: file }], {});

  assert.deepEqual(fs.readFileSync(file), before);
});
