/**
 * Band-energy envelopes, used to find where a track's arrangement changes.
 *
 * Three bands carry almost all the structural information in 4/4 electronic
 * music: the kick (below ~150 Hz), the whole mix, and the hats/risers above
 * ~4 kHz. A breakdown is the kick dropping out while the top end keeps going; a
 * build is the top end climbing; the drop is the kick returning.
 *
 * Everything is computed in one pass with running filter state rather than by
 * materialising filtered copies of the signal — a 10-minute track is ~105 MB per
 * copy, and the analysis pass runs several tracks concurrently.
 */

/** 100 ms is fine enough to place a cue and coarse enough to stay cheap. */
export const FRAME_SECONDS = 0.1;

const LOW_CUTOFF_HZ = 150;
const HIGH_CUTOFF_HZ = 4000;
const Q = 0.707;

/** RBJ cookbook biquad, normalised so a0 is 1. */
function lowpassCoefficients(sampleRate, freq) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0
  };
}

function highpassCoefficients(sampleRate, freq) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0
  };
}

function createBiquad(coefficients) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const { b0, b1, b2, a1, a2 } = coefficients;

  return function step(x) {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @returns {{ frameSeconds: number, low: Float32Array, broad: Float32Array, high: Float32Array }}
 *   per-frame RMS for each band
 */
export function computeEnergyBands(samples, sampleRate) {
  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameCount = Math.max(1, Math.floor(samples.length / frameSize));

  const low = new Float32Array(frameCount);
  const broad = new Float32Array(frameCount);
  const high = new Float32Array(frameCount);

  const lowFilter = createBiquad(lowpassCoefficients(sampleRate, LOW_CUTOFF_HZ));
  const highFilter = createBiquad(highpassCoefficients(sampleRate, HIGH_CUTOFF_HZ));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = start + frameSize;

    let lowSum = 0;
    let broadSum = 0;
    let highSum = 0;

    for (let i = start; i < end; i += 1) {
      const x = samples[i];
      const l = lowFilter(x);
      const h = highFilter(x);
      lowSum += l * l;
      broadSum += x * x;
      highSum += h * h;
    }

    low[frame] = Math.sqrt(lowSum / frameSize);
    broad[frame] = Math.sqrt(broadSum / frameSize);
    high[frame] = Math.sqrt(highSum / frameSize);
  }

  return { frameSeconds: FRAME_SECONDS, low, broad, high };
}

/**
 * Running maximum over a sliding window.
 *
 * Needed because a kick is a transient: at 100 ms frames only about one frame per
 * beat catches the attack, so the raw low-band median describes the gap between
 * kicks rather than the kick itself. Taking the peak across a beat turns "is the
 * kick playing" into a signal that holds steady through a section.
 *
 * @param {ArrayLike<number>} values
 * @param {number} windowFrames
 * @returns {Float32Array}
 */
export function runningMax(values, windowFrames) {
  const width = Math.max(1, Math.round(windowFrames));
  const out = new Float32Array(values.length);
  const half = width >> 1;

  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + width - half);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      if (values[j] > peak) peak = values[j];
    }
    out[i] = peak;
  }
  return out;
}

/** @param {ArrayLike<number>} values */
export function median(values) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Linear amplitude to dBFS, floored so silence does not become -Infinity. */
export function toDb(amplitude) {
  return 20 * Math.log10(Math.max(amplitude, 1e-6));
}

/**
 * A rough 1-10 "how hard does this hit" score, in the spirit of the energy rating
 * DJs already sort by. Deliberately coarse: it exists to order a set, not to be
 * precise.
 *
 * @param {{ low: Float32Array, broad: Float32Array, high: Float32Array }} bands
 */
export function estimateEnergyLevel(bands) {
  const broadMedian = median(bands.broad);
  const lowMedian = median(bands.low);
  const highMedian = median(bands.high);
  if (broadMedian <= 0) return 1;

  // Loudness sets the floor: -30 dBFS median is sedate, -8 is peak-time.
  const loudness = toDb(broadMedian);
  const loudnessScore = clamp01((loudness + 30) / 22);

  // Kick dominance separates a driving track from an ambient one of equal loudness.
  const kickScore = clamp01(lowMedian / broadMedian / 0.8);
  // Top-end presence separates busy percussive tracks from dubby ones.
  const brightnessScore = clamp01(highMedian / broadMedian / 0.35);

  const combined = 0.5 * loudnessScore + 0.35 * kickScore + 0.15 * brightnessScore;
  return Math.min(10, Math.max(1, Math.round(1 + combined * 9)));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
