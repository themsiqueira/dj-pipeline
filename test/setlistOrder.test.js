import test from "node:test";
import assert from "node:assert/strict";

import { buildSetOrder, arcTarget } from "../src/setlist/order.js";
import { totalScore, toFeatures } from "../src/setlist/score.js";

/** @param {object} spec */
function track(spec) {
  return {
    title: spec.title,
    analysis: { bpm: spec.bpm, camelot: spec.camelot, energyLevel: spec.energy },
    style: spec.style ? { style: spec.style, source: "metadata" } : null
  };
}

const SET = [
  track({ title: "Peak", bpm: 130, camelot: "9A", energy: 9, style: "techno" }),
  track({ title: "Opener", bpm: 122, camelot: "8A", energy: 3, style: "melodic techno" }),
  track({ title: "Builder", bpm: 126, camelot: "8A", energy: 6, style: "melodic techno" }),
  track({ title: "Closer", bpm: 128, camelot: "9A", energy: 7, style: "techno" }),
  track({ title: "Warm", bpm: 124, camelot: "8B", energy: 4, style: "melodic techno" })
];

test("the result is a permutation, with nothing dropped or duplicated", () => {
  const { tracks } = buildSetOrder(SET);

  assert.equal(tracks.length, SET.length);
  const titles = tracks.map((t) => t.title).sort();
  const original = SET.map((t) => t.title).sort();
  assert.deepEqual(titles, original);
  assert.equal(new Set(tracks).size, SET.length, "each track object should appear exactly once");
});

test("the suggested order is never worse than the order given", () => {
  const suggested = totalScore(buildSetOrder(SET).tracks.map(toFeatures));
  const original = totalScore(SET.map(toFeatures));
  assert.ok(
    suggested >= original - 1e-9,
    `suggested ${suggested.toFixed(3)} should not be worse than input ${original.toFixed(3)}`
  );
});

test("the set opens on a low-energy track and peaks later", () => {
  const { tracks } = buildSetOrder(SET);
  const energies = tracks.map((t) => t.analysis.energyLevel);

  assert.equal(energies[0], Math.min(...energies), "the opener should be the calmest track");

  const peakAt = energies.indexOf(Math.max(...energies));
  assert.ok(peakAt > 0, "the peak should not be the first track");
  assert.ok(peakAt >= Math.floor(energies.length / 2), `peak landed at position ${peakAt}`);
});

test("energy rises across the first half", () => {
  const { tracks } = buildSetOrder(SET);
  const energies = tracks.map((t) => t.analysis.energyLevel);
  const firstHalf = energies.slice(0, Math.ceil(energies.length / 2));

  assert.ok(
    firstHalf[firstHalf.length - 1] > firstHalf[0],
    `expected a warm-up, got ${energies.join(", ")}`
  );
});

test("transitions are reported for each adjacent pair", () => {
  const { tracks, transitions } = buildSetOrder(SET);

  assert.equal(transitions.length, tracks.length - 1);
  transitions.forEach((transition, index) => {
    assert.equal(transition.fromTrack, tracks[index]);
    assert.equal(transition.toTrack, tracks[index + 1]);
    assert.ok(transition.score >= 0 && transition.score <= 1);
    assert.ok(transition.key.move, "each transition should name its harmonic move");
  });
});

test("trivial inputs are returned untouched", () => {
  assert.deepEqual(buildSetOrder([]).tracks, []);
  assert.equal(buildSetOrder([]).transitions.length, 0);

  const single = [SET[0]];
  assert.deepEqual(buildSetOrder(single).tracks, single);
  assert.equal(buildSetOrder(single).transitions.length, 0);

  assert.equal(buildSetOrder(null).tracks.length, 0);
});

test("tracks that failed analysis are still placed, not dropped", () => {
  const mixed = [
    track({ title: "Measured", bpm: 128, camelot: "8A", energy: 5, style: "techno" }),
    { title: "Unmeasured", analysis: null, style: null },
    track({ title: "Also measured", bpm: 129, camelot: "9A", energy: 7, style: "techno" })
  ];

  const { tracks } = buildSetOrder(mixed);
  assert.equal(tracks.length, 3);
  assert.ok(tracks.some((t) => t.title === "Unmeasured"));
});

test("ordering is deterministic", () => {
  const first = buildSetOrder(SET).tracks.map((t) => t.title);
  const second = buildSetOrder(SET).tracks.map((t) => t.title);
  assert.deepEqual(first, second);
});

test("a bad input order gets meaningfully improved", () => {
  // Deliberately alternating extremes, which is the worst arrangement of this set.
  const jagged = [
    track({ title: "A", bpm: 128, camelot: "8A", energy: 10, style: "techno" }),
    track({ title: "B", bpm: 128, camelot: "8A", energy: 1, style: "techno" }),
    track({ title: "C", bpm: 128, camelot: "8A", energy: 9, style: "techno" }),
    track({ title: "D", bpm: 128, camelot: "8A", energy: 2, style: "techno" }),
    track({ title: "E", bpm: 128, camelot: "8A", energy: 6, style: "techno" })
  ];

  const result = buildSetOrder(jagged);
  assert.ok(result.improvedOnInput, "a jagged order should be reported as improved");

  const energies = result.tracks.map((t) => t.analysis.energyLevel);
  assert.equal(energies[0], 1, "should open on the calmest");
  assert.ok(energies[1] > energies[0], "and climb from there");
});

test("the arc rises to a late peak then eases off", () => {
  assert.equal(arcTarget(0), 0);
  assert.ok(arcTarget(0.5) > arcTarget(0.25));
  assert.equal(arcTarget(0.75), 1, "the peak sits three quarters through");
  assert.ok(arcTarget(1) < 1, "the set should come down at the end");
  assert.ok(arcTarget(1) > 0.5, "but not back to where it started");
});

test("keys are kept compatible where the energy arc allows", () => {
  // Two harmonic families at matched tempo and energy; a good order should not
  // bounce between them any more than it has to.
  const twoFamilies = [
    track({ title: "8A a", bpm: 128, camelot: "8A", energy: 4 }),
    track({ title: "3B a", bpm: 128, camelot: "3B", energy: 5 }),
    track({ title: "9A a", bpm: 128, camelot: "9A", energy: 6 }),
    track({ title: "3B b", bpm: 128, camelot: "3B", energy: 7 })
  ];

  const { transitions } = buildSetOrder(twoFamilies);
  const clashes = transitions.filter((t) => t.key.move === "clash").length;
  assert.ok(clashes <= 1, `expected at most one unavoidable clash, got ${clashes}`);
});

test("a realistic set size orders quickly", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    track({
      title: `Track ${i}`,
      bpm: 120 + (i % 12),
      camelot: `${(i % 12) + 1}${i % 2 ? "A" : "B"}`,
      energy: (i % 10) + 1,
      style: i % 3 === 0 ? "techno" : "tech house"
    })
  );

  const startedAt = Date.now();
  const { tracks } = buildSetOrder(many);
  const elapsed = Date.now() - startedAt;

  assert.equal(tracks.length, 60);
  assert.ok(elapsed < 5000, `ordering 60 tracks took ${elapsed}ms`);
});
