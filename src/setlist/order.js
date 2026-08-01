/**
 * Put the tracks in an order worth playing.
 *
 * Two things are being optimised at once, and they pull against each other. Each
 * individual transition wants the smallest possible jump in key, tempo and
 * energy — but a set built only from smooth transitions is a flat set. It never
 * goes anywhere. So the objective also rewards the shape of the whole thing:
 * warm up, build to a peak about three quarters through, then bring it down.
 *
 * The search is greedy nearest-neighbour followed by 2-opt. At set scale (tens of
 * tracks) that runs in milliseconds and gets close enough to optimal that a
 * better algorithm would not produce an audibly better set.
 */

import { scoreTransition, toFeatures } from "./score.js";

/** Split between per-transition smoothness and the shape of the set overall. */
const WEIGHT_FLOW = 0.65;
const WEIGHT_ARC = 0.35;

/** Where the set peaks, as a fraction of its length. */
const PEAK_POSITION = 0.75;

/** How far the energy comes back down after the peak, as a fraction of the rise. */
const COOLDOWN_DROP = 0.4;

/** Guards against a pathological input spinning the improvement loop. */
const MAX_2OPT_PASSES = 40;

/**
 * The energy the set wants at a given point, as a 0-1 shape.
 *
 * @param {number} position 0 at the first track, 1 at the last
 */
export function arcTarget(position) {
  if (position <= PEAK_POSITION) {
    return PEAK_POSITION === 0 ? 1 : position / PEAK_POSITION;
  }
  const past = (position - PEAK_POSITION) / (1 - PEAK_POSITION);
  return 1 - COOLDOWN_DROP * past;
}

/**
 * How closely a running order follows the intended arc, 0 to 1.
 *
 * The target is scaled to the energy actually present. A set of uniformly calm
 * tracks should not be marked down for failing to reach an energy it does not
 * contain.
 */
function arcFit(features, order) {
  const energies = order.map((index) => features[index].energyLevel);
  const known = energies.filter((e) => Number.isFinite(e) && e > 0);
  if (known.length < 2) return 1;

  const min = Math.min(...known);
  const max = Math.max(...known);
  const range = max - min;
  if (range === 0) return 1;

  const median = known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)];

  let error = 0;
  for (let i = 0; i < order.length; i += 1) {
    const position = order.length === 1 ? 0 : i / (order.length - 1);
    const actual = Number.isFinite(energies[i]) && energies[i] > 0 ? energies[i] : median;
    const target = min + arcTarget(position) * range;
    error += Math.abs(actual - target) / range;
  }

  return Math.max(0, 1 - error / order.length);
}

/** Mean transition score across the running order. */
function flowScore(matrix, order) {
  if (order.length < 2) return 1;
  let total = 0;
  for (let i = 0; i < order.length - 1; i += 1) {
    total += matrix[order[i]][order[i + 1]];
  }
  return total / (order.length - 1);
}

/**
 * The single number the search maximises.
 *
 * @returns {number} 0 to 1
 */
function objective(matrix, features, order) {
  return WEIGHT_FLOW * flowScore(matrix, order) + WEIGHT_ARC * arcFit(features, order);
}

/** Pairwise transition scores. Asymmetric: A into B is not B into A. */
function buildMatrix(features) {
  return features.map((from) => features.map((to) => scoreTransition(from, to).score));
}

/**
 * Greedy nearest-neighbour from the calmest track.
 *
 * Opening on the lowest-energy track is not an optimisation, it is how sets
 * start. The candidate choice at each step blends transition quality with how
 * well that track's energy suits the position it would occupy, so the greedy
 * pass already leans into the arc rather than leaving it all to 2-opt.
 */
function greedyOrder(matrix, features) {
  const count = features.length;
  const energies = features.map((f) => (Number.isFinite(f.energyLevel) ? f.energyLevel : 5));
  const min = Math.min(...energies);
  const max = Math.max(...energies);
  const range = max - min;

  let current = energies.indexOf(min);
  const used = new Set([current]);
  const order = [current];

  while (order.length < count) {
    let best = -1;
    let bestScore = -Infinity;

    for (let candidate = 0; candidate < count; candidate += 1) {
      if (used.has(candidate)) continue;

      const position = count === 1 ? 0 : order.length / (count - 1);
      const target = range === 0 ? energies[candidate] : min + arcTarget(position) * range;
      const arcMatch = range === 0 ? 1 : 1 - Math.abs(energies[candidate] - target) / range;

      const score = WEIGHT_FLOW * matrix[current][candidate] + WEIGHT_ARC * arcMatch;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    used.add(best);
    order.push(best);
    current = best;
  }

  return order;
}

/**
 * 2-opt: reverse each sub-segment and keep the reversal when it improves.
 *
 * The objective is recomputed in full rather than by the usual edge-delta trick,
 * because reversing a segment flips the direction of every transition inside it
 * (A into B is not B into A) and shifts every track's position in the arc. At set
 * scale the honest recompute is cheap enough not to matter.
 */
function twoOpt(matrix, features, initial) {
  let order = initial.slice();
  let best = objective(matrix, features, order);

  for (let pass = 0; pass < MAX_2OPT_PASSES; pass += 1) {
    let improved = false;

    for (let i = 0; i < order.length - 1; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const candidate = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        const score = objective(matrix, features, candidate);
        if (score > best + 1e-9) {
          order = candidate;
          best = score;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return { order, score: best };
}

/**
 * @param {Array<object>} tracks tracks carrying `analysis` and `style`
 * @returns {{
 *   tracks: Array<object>,
 *   transitions: Array<object>,
 *   score: number,
 *   improvedOnInput: boolean
 * }}
 */
export function buildSetOrder(tracks) {
  const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  if (list.length < 2) {
    return { tracks: list.slice(), transitions: [], score: 1, improvedOnInput: false };
  }

  const features = list.map(toFeatures);
  const matrix = buildMatrix(features);
  const identity = list.map((_, index) => index);

  // Refining the playlist's own order as well as the greedy one costs one extra
  // 2-opt pass and guarantees the suggestion is never worse than what the user
  // already had — which would be an embarrassing thing to hand back.
  const fromGreedy = twoOpt(matrix, features, greedyOrder(matrix, features));
  const fromInput = twoOpt(matrix, features, identity);
  const inputScore = objective(matrix, features, identity);

  const winner = fromGreedy.score >= fromInput.score ? fromGreedy : fromInput;
  const ordered = winner.order.map((index) => list[index]);

  const transitions = [];
  for (let i = 0; i < winner.order.length - 1; i += 1) {
    const from = features[winner.order[i]];
    const to = features[winner.order[i + 1]];
    transitions.push({
      fromIndex: i,
      toIndex: i + 1,
      fromTrack: ordered[i],
      toTrack: ordered[i + 1],
      ...scoreTransition(from, to)
    });
  }

  return {
    tracks: ordered,
    transitions,
    score: winner.score,
    improvedOnInput: winner.score > inputScore + 1e-9
  };
}
