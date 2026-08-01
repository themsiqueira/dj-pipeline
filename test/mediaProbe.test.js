import test from "node:test";
import assert from "node:assert/strict";
import { parseFfmetadata, parseDurationSec } from "../src/mediaProbe.js";

test("reads the global tag block", () => {
  const tags = parseFfmetadata(
    [";FFMETADATA1", "title=Night Drive", "artist=Some Artist", "genre=Melodic Techno"].join("\n")
  );

  assert.equal(tags.title, "Night Drive");
  assert.equal(tags.artist, "Some Artist");
  assert.equal(tags.genre, "Melodic Techno");
});

test("keys are lowercased so TITLE and title are the same field", () => {
  assert.equal(parseFfmetadata("TITLE=Loud\nARTIST=Someone").title, "Loud");
});

test("stream and chapter sections are ignored", () => {
  const tags = parseFfmetadata(
    [";FFMETADATA1", "title=Real Title", "[STREAM]", "title=Audio", "[CHAPTER]", "title=Intro"].join("\n")
  );

  assert.equal(tags.title, "Real Title", "a stream's own title must not win over the file's");
});

test("escaped separators survive", () => {
  const tags = parseFfmetadata("title=Bass\\=Heavy\ncomment=part one\\; part two");

  assert.equal(tags.title, "Bass=Heavy");
  assert.equal(tags.comment, "part one; part two");
});

test("a value split across lines is rejoined", () => {
  const tags = parseFfmetadata("comment=first line\\\nsecond line\ntitle=After");

  assert.equal(tags.comment, "first line\nsecond line");
  assert.equal(tags.title, "After", "the parser should resume after a continued value");
});

test("blank values and comment lines are dropped", () => {
  const tags = parseFfmetadata([";FFMETADATA1", "#a comment", "title=", "artist=Real"].join("\n"));

  assert.equal("title" in tags, false);
  assert.equal(tags.artist, "Real");
});

test("garbage does not throw", () => {
  assert.deepEqual(parseFfmetadata(""), {});
  assert.deepEqual(parseFfmetadata(undefined), {});
  assert.deepEqual(parseFfmetadata("no equals sign here"), {});
});

test("duration is read out of the ffmpeg banner", () => {
  const stderr = "  Duration: 00:04:12.34, start: 0.000000, bitrate: 320 kb/s";

  assert.equal(parseDurationSec(stderr), 4 * 60 + 12.34);
});

test("durations over an hour are handled", () => {
  assert.equal(parseDurationSec("Duration: 01:30:00.00, start: 0"), 5400);
});

test("an unknown duration reads as zero rather than NaN", () => {
  assert.equal(parseDurationSec("Duration: N/A, bitrate: N/A"), 0);
  assert.equal(parseDurationSec(""), 0);
});
