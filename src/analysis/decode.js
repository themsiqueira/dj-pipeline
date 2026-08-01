import { getFfmpegExecutable } from "../binaries.js";
import { spawnTrackedBinary } from "../spawnUtil.js";

/**
 * Essentia's RhythmExtractor2013 and KeyExtractor are both tuned for 44.1 kHz;
 * feeding them anything else skews the results.
 */
export const ANALYSIS_SAMPLE_RATE = 44100;

const BYTES_PER_SAMPLE = 4;

/**
 * Decode any audio file to mono 32-bit float PCM.
 *
 * This doubles as the duration source. `ffprobe` is not bundled in `vendor/`, and
 * Rekordbox silently drops cue points from tracks whose `TotalTime` is missing, so
 * deriving the duration from the sample count here avoids shipping another binary
 * for a number we get for free.
 *
 * @param {string} filePath
 * @param {{ signal?: AbortSignal, sampleRate?: number }} [options]
 * @returns {Promise<{ samples: Float32Array, sampleRate: number, durationSec: number }>}
 */
export async function decodeToMonoPcm(filePath, options = {}) {
  const { signal, sampleRate = ANALYSIS_SAMPLE_RATE } = options;

  const args = [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-i",
    filePath,
    // Explicit: FLAC files carry an attached cover image as a video stream, and
    // without this ffmpeg can pick it instead of the audio.
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "-"
  ];

  const { stdout } = await spawnTrackedBinary(getFfmpegExecutable(), args, { signal });

  const usableBytes = stdout.length - (stdout.length % BYTES_PER_SAMPLE);
  if (usableBytes <= 0) {
    throw new Error(`No audio decoded from ${filePath}`);
  }

  // Copy rather than view: the Buffer comes from a pooled allocation whose
  // byteOffset is rarely 4-aligned, which Float32Array rejects outright. One
  // memcpy into a fresh (therefore aligned) buffer beats a per-sample read loop
  // by orders of magnitude at ~26M samples for a 10-minute track.
  // f32le matches host order on x64 and arm64; both are little-endian.
  const samples = new Float32Array(usableBytes / BYTES_PER_SAMPLE);
  Buffer.from(samples.buffer).set(stdout.subarray(0, usableBytes));

  return {
    samples,
    sampleRate,
    durationSec: samples.length / sampleRate
  };
}
