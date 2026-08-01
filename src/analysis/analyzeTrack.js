import { decodeToMonoPcm } from "./decode.js";
import { getEssentia } from "./essentia.js";
import { computeEnergyBands, estimateEnergyLevel } from "./energy.js";
import { toCamelot, camelotToClassical } from "./camelot.js";
import { detectStructure } from "./structure.js";

/**
 * Below this, a detected tempo is almost certainly an octave error rather than a
 * real half-time track. Folding is deliberately conservative: 174 BPM drum and
 * bass and 150 BPM hard techno are both legitimate and must survive untouched.
 */
const MIN_PLAUSIBLE_BPM = 70;
const MAX_PLAUSIBLE_BPM = 200;

function foldTempoOctave(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  let value = bpm;
  while (value < MIN_PLAUSIBLE_BPM) value *= 2;
  while (value > MAX_PLAUSIBLE_BPM) value /= 2;
  return value;
}

/**
 * Measure one downloaded file: tempo, beat grid, key, energy, and the structural
 * cue points that follow from them.
 *
 * @param {string} filePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object>} analysis record; `bpm`/`key` may be null when
 *   Essentia is unavailable, in which case duration and energy are still returned
 */
export async function analyzeTrack(filePath, options = {}) {
  const { signal } = options;

  const { samples, sampleRate, durationSec } = await decodeToMonoPcm(filePath, { signal });
  if (signal?.aborted) throw new Error("Cancelled");

  const bands = computeEnergyBands(samples, sampleRate);
  const energyLevel = estimateEnergyLevel(bands);

  const essentia = getEssentia();
  let bpm = null;
  let beats = [];
  let beatConfidence = 0;
  let camelot = null;
  let keyStrength = 0;

  if (essentia) {
    let vector = null;
    try {
      vector = essentia.arrayToVector(samples);

      const rhythm = essentia.RhythmExtractor2013(vector);
      bpm = foldTempoOctave(rhythm.bpm);
      beatConfidence = Number(rhythm.confidence) || 0;
      beats = Array.from(essentia.vectorToArray(rhythm.ticks));

      const key = essentia.KeyExtractor(vector);
      camelot = toCamelot(key.key, key.scale);
      keyStrength = Number(key.strength) || 0;
    } finally {
      // The WASM heap does not grow back on its own; a leaked vector per track
      // would exhaust it partway through a large playlist.
      vector?.delete?.();
    }
  }

  const structure = detectStructure({ bands, beats, bpm, durationSec });

  return {
    durationSec,
    sampleRate,
    bpm,
    beatConfidence,
    beats,
    camelot,
    keyClassical: camelotToClassical(camelot),
    keyStrength,
    energyLevel,
    firstDownbeatSec: structure.firstDownbeatSec,
    cues: structure.cues,
    sections: structure.sections
  };
}
