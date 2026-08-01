/**
 * How well one track mixes into another, as a number between 0 and 1.
 *
 * Four measured relationships, weighted by how much they actually constrain a
 * mix. Tempo and key are near-hard limits — a 12% tempo gap cannot be beatmatched
 * on a CDJ's pitch fader, and a clashing key is audible to everyone in the room.
 * Energy and style are taste, and are weighted accordingly.
 *
 * Pure functions: no IO, no audio. The ordering pass calls this O(n squared)
 * times, so it stays cheap.
 */

import { keyCompatibility } from "../analysis/camelot.js";
import { styleAffinity } from "../analysis/genre.js";

/**
 * Relative weights. Key and tempo dominate because they are what makes a blend
 * possible at all; style and energy shape a set that is merely competent into one
 * that is enjoyable.
 */
const WEIGHTS = {
  key: 0.35,
  bpm: 0.35,
  energy: 0.15,
  style: 0.15
};

/** A CDJ's default pitch range. Beyond it, beatmatching means changing tempo. */
const COMFORTABLE_PITCH_PERCENT = 6;

/** Where a tempo gap stops being mixable at all. */
const MAX_PITCH_PERCENT = 12;

/**
 * Tempo distance, allowing for half and double time.
 *
 * 87 into 174 is an ordinary move — the DJ plays one track at half the other's
 * feel and the beats still line up. Treating that as an 87 BPM gap would rule out
 * every drum and bass set that opens on a downtempo track.
 *
 * @param {number} fromBpm
 * @param {number} toBpm
 * @returns {{ score: number, percent: number, ratio: 1 | 2 | 0.5, adjustedToBpm: number }}
 */
export function bpmProximity(fromBpm, toBpm) {
  if (!fromBpm || !toBpm || !Number.isFinite(fromBpm) || !Number.isFinite(toBpm)) {
    // An unmeasured tempo must not push the track to the end of every set.
    return { score: 0.5, percent: 0, ratio: 1, adjustedToBpm: toBpm || 0 };
  }

  /** @type {Array<1 | 2 | 0.5>} */
  const ratios = [1, 2, 0.5];
  let best = null;

  for (const ratio of ratios) {
    const adjusted = toBpm * ratio;
    const percent = Math.abs((adjusted - fromBpm) / fromBpm) * 100;
    if (!best || percent < best.percent) best = { percent, ratio, adjustedToBpm: adjusted };
  }

  const { percent, ratio, adjustedToBpm } = /** @type {NonNullable<typeof best>} */ (best);

  let score;
  if (percent <= 1) {
    // Inside a rounding error of each other: beatmatch straight.
    score = 1;
  } else if (percent <= COMFORTABLE_PITCH_PERCENT) {
    score = 1 - (percent - 1) * (0.3 / (COMFORTABLE_PITCH_PERCENT - 1));
  } else if (percent <= MAX_PITCH_PERCENT) {
    score = 0.7 - (percent - COMFORTABLE_PITCH_PERCENT) * (0.6 / (MAX_PITCH_PERCENT - COMFORTABLE_PITCH_PERCENT));
  } else {
    score = 0.05;
  }

  // A half or double-time move is a real, deliberate gear change rather than a
  // straight beatmatch, so it is scored slightly below an equivalent same-tempo
  // move without being treated as a clash.
  if (ratio !== 1) score *= 0.9;

  return { score: clamp01(score), percent, ratio, adjustedToBpm };
}

/**
 * Energy movement between two tracks, 1-10 scale.
 *
 * Holding or lifting slightly is the ideal; the failure being scored against is
 * the jarring one, in either direction. Dropping the floor four points is worse
 * than lifting it four, so the penalties are asymmetric.
 *
 * @param {number | null} fromEnergy
 * @param {number | null} toEnergy
 * @returns {{ score: number, delta: number }}
 */
export function energyFlow(fromEnergy, toEnergy) {
  if (!fromEnergy || !toEnergy) return { score: 0.5, delta: 0 };

  const delta = toEnergy - fromEnergy;
  const table = { "-4": 0.3, "-3": 0.45, "-2": 0.6, "-1": 0.8, 0: 1, 1: 1, 2: 0.85, 3: 0.65, 4: 0.4 };
  const clamped = Math.max(-4, Math.min(4, delta));

  return { score: table[String(clamped)] ?? 0.3, delta };
}

/**
 * Score the transition from one track into another.
 *
 * @param {{ bpm?: number|null, camelot?: string|null, energyLevel?: number|null, style?: string|null }} from
 * @param {{ bpm?: number|null, camelot?: string|null, energyLevel?: number|null, style?: string|null }} to
 * @returns {{ score: number, key: object, bpm: object, energy: object, style: { score: number } }}
 */
export function scoreTransition(from, to) {
  const key = keyCompatibility(from?.camelot ?? null, to?.camelot ?? null);
  const bpm = bpmProximity(from?.bpm ?? 0, to?.bpm ?? 0);
  const energy = energyFlow(from?.energyLevel ?? null, to?.energyLevel ?? null);
  const style = { score: styleAffinity(from?.style ?? null, to?.style ?? null) };

  const score =
    key.score * WEIGHTS.key +
    bpm.score * WEIGHTS.bpm +
    energy.score * WEIGHTS.energy +
    style.score * WEIGHTS.style;

  return { score: clamp01(score), key, bpm, energy, style };
}

/**
 * Reduce a pipeline track to just what scoring needs, so the ordering pass never
 * touches file paths or cue arrays.
 *
 * @param {object} track
 */
export function toFeatures(track) {
  return {
    bpm: track?.analysis?.bpm ?? null,
    camelot: track?.analysis?.camelot ?? null,
    energyLevel: track?.analysis?.energyLevel ?? null,
    style: track?.style?.style ?? null
  };
}

/** Total score of a running order, used to compare candidate orderings. */
export function totalScore(features) {
  let total = 0;
  for (let i = 0; i < features.length - 1; i += 1) {
    total += scoreTransition(features[i], features[i + 1]).score;
  }
  return total;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
