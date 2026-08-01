import test from "node:test";
import assert from "node:assert/strict";
import { makeOutputName, parseSourceLayout } from "../src/audio.js";
import {
  normalizeAudioFormat,
  AUDIO_FORMAT,
  DEFAULT_AUDIO_FORMAT
} from "../src/audioFormats.js";

test("normalizeAudioFormat falls back to MP3 rather than throwing", () => {
  assert.equal(normalizeAudioFormat("flac"), AUDIO_FORMAT.FLAC);
  assert.equal(normalizeAudioFormat("FLAC"), AUDIO_FORMAT.FLAC);
  assert.equal(normalizeAudioFormat("  flac  "), AUDIO_FORMAT.FLAC);
  assert.equal(normalizeAudioFormat("mp3"), AUDIO_FORMAT.MP3);
  assert.equal(normalizeAudioFormat("wav"), DEFAULT_AUDIO_FORMAT);
  assert.equal(normalizeAudioFormat(undefined), DEFAULT_AUDIO_FORMAT);
  assert.equal(normalizeAudioFormat(null), DEFAULT_AUDIO_FORMAT);
});

test("makeOutputName uses the requested extension", () => {
  const used = new Set();
  assert.equal(makeOutputName({ title: "Song", stableId: "id1", usedBasenames: used }), "Song.mp3");
  assert.equal(
    makeOutputName({ title: "Other", stableId: "id2", usedBasenames: used, ext: "flac" }),
    "Other.flac"
  );
});

test("makeOutputName disambiguates duplicate titles with the stable id", () => {
  const used = new Set();
  assert.equal(
    makeOutputName({ title: "Same", stableId: "aaa", usedBasenames: used, ext: "flac" }),
    "Same.flac"
  );
  assert.equal(
    makeOutputName({ title: "Same", stableId: "bbb", usedBasenames: used, ext: "flac" }),
    "Same - bbb.flac"
  );
});

test("makeOutputName survives a missing title", () => {
  const used = new Set();
  assert.equal(
    makeOutputName({ title: "", stableId: "id", usedBasenames: used }),
    "Unknown Title.mp3"
  );
});

// Guards the FLAC sample-rate fix: loudnorm runs at 192 kHz internally, so the encode
// has to restore the source rate explicitly or FLAC files come out upsampled.
test("parseSourceLayout reads rate and channels from the ffmpeg input line", () => {
  const stderr = [
    "Input #0, matroska,webm, from 'x.webm':",
    "  Stream #0:0(eng): Audio: opus, 48000 Hz, stereo, fltp (default)",
    "Output #0, null, to 'pipe:':",
    "  Stream #0:0: Audio: pcm_s16le, 192000 Hz, stereo, s16"
  ].join("\n");
  assert.deepEqual(parseSourceLayout(stderr), { rate: 48000, channels: 2 });
});

test("parseSourceLayout handles mono and surround layouts", () => {
  assert.deepEqual(
    parseSourceLayout("Stream #0:0: Audio: aac, 44100 Hz, mono, fltp"),
    { rate: 44100, channels: 1 }
  );
  assert.deepEqual(
    parseSourceLayout("Stream #0:0: Audio: ac3, 48000 Hz, 5.1, fltp"),
    { rate: 48000, channels: 6 }
  );
});

test("parseSourceLayout falls back to CD stereo on unparseable input", () => {
  assert.deepEqual(parseSourceLayout(""), { rate: 44100, channels: 2 });
  assert.deepEqual(parseSourceLayout("no audio here"), { rate: 44100, channels: 2 });
  assert.deepEqual(parseSourceLayout(undefined), { rate: 44100, channels: 2 });
});

test("parseSourceLayout rejects an implausible sample rate", () => {
  assert.deepEqual(
    parseSourceLayout("Stream #0:0: Audio: pcm, 999999 Hz, stereo"),
    { rate: 44100, channels: 2 }
  );
});
