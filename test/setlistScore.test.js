import test from "node:test";
import assert from "node:assert/strict";

import { bpmProximity, energyFlow, scoreTransition, toFeatures, totalScore } from "../src/setlist/score.js";

test("identical tempos beatmatch straight", () => {
  const result = bpmProximity(128, 128);
  assert.equal(result.score, 1);
  assert.equal(result.ratio, 1);
  assert.equal(result.percent, 0);
});

test("half and double time are treated as a match, not a clash", () => {
  const doubled = bpmProximity(87, 174);
  assert.equal(doubled.ratio, 0.5, "174 should be heard at half time against 87");
  assert.ok(doubled.score > 0.8, `expected a mixable score, got ${doubled.score}`);

  const halved = bpmProximity(174, 87);
  assert.equal(halved.ratio, 2);
  assert.ok(halved.score > 0.8);
});

test("a half-time move scores below the equivalent straight beatmatch", () => {
  assert.ok(bpmProximity(87, 174).score < bpmProximity(128, 128).score);
});

test("tempo score decays with the size of the gap", () => {
  const close = bpmProximity(128, 129).score;
  const stretch = bpmProximity(128, 134).score;
  const hard = bpmProximity(128, 140).score;
  const impossible = bpmProximity(128, 175).score;

  assert.ok(close > stretch, "1 BPM should beat 6 BPM");
  assert.ok(stretch > hard, "6 BPM should beat 12 BPM");
  assert.ok(hard > impossible, "12 BPM should beat an unmixable gap");
  assert.ok(impossible < 0.2, "an unmixable gap should score near zero");
});

test("an unmeasured tempo is neutral rather than disqualifying", () => {
  assert.equal(bpmProximity(0, 128).score, 0.5);
  assert.equal(bpmProximity(128, null).score, 0.5);
});

test("energy flow prefers holding or lifting slightly", () => {
  assert.equal(energyFlow(6, 6).score, 1);
  assert.equal(energyFlow(6, 7).score, 1);
  assert.ok(energyFlow(6, 8).score < 1, "a two-point jump should cost something");
});

test("dropping the floor is penalised harder than lifting it", () => {
  assert.ok(energyFlow(8, 5).score < energyFlow(5, 8).score);
});

test("energy deltas beyond the table do not fall through to zero", () => {
  const huge = energyFlow(1, 10);
  assert.ok(huge.score > 0, "a 9-point jump must still score above zero");
  assert.equal(huge.delta, 9, "the true delta should be reported even when clamped for scoring");
});

test("a perfect transition beats a clashing one", () => {
  const perfect = scoreTransition(
    { bpm: 128, camelot: "8A", energyLevel: 6, style: "melodic techno" },
    { bpm: 128, camelot: "8A", energyLevel: 7, style: "melodic techno" }
  );
  const clash = scoreTransition(
    { bpm: 128, camelot: "8A", energyLevel: 6, style: "melodic techno" },
    { bpm: 150, camelot: "3B", energyLevel: 2, style: "hardcore" }
  );

  assert.ok(perfect.score > 0.9, `expected a strong score, got ${perfect.score}`);
  assert.ok(clash.score < 0.4, `expected a weak score, got ${clash.score}`);
});

test("scores stay inside 0 and 1 for any input", () => {
  const inputs = [
    [{}, {}],
    [{ bpm: 128 }, { camelot: "8A" }],
    [
      { bpm: 300, camelot: "12B", energyLevel: 10, style: "hardcore" },
      { bpm: 40, camelot: "6A", energyLevel: 1, style: "ambient" }
    ]
  ];
  for (const [from, to] of inputs) {
    const { score } = scoreTransition(from, to);
    assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  }
});

test("key compatibility moves the score in the right direction", () => {
  const base = { bpm: 128, camelot: "8A", energyLevel: 6, style: "techno" };
  const sameKey = scoreTransition(base, { ...base, camelot: "8A" }).score;
  const fifth = scoreTransition(base, { ...base, camelot: "9A" }).score;
  const clash = scoreTransition(base, { ...base, camelot: "2B" }).score;

  assert.ok(sameKey >= fifth, "same key should be at least as good as a fifth");
  assert.ok(fifth > clash, "a fifth should beat a clash");
});

test("the reported components explain the score", () => {
  const result = scoreTransition(
    { bpm: 126, camelot: "8A", energyLevel: 5, style: "tech house" },
    { bpm: 128, camelot: "9A", energyLevel: 7, style: "techno" }
  );

  assert.equal(result.key.move, "+1 (fifth up)");
  assert.ok(result.bpm.percent > 1 && result.bpm.percent < 2);
  assert.equal(result.energy.delta, 2);
  assert.ok(result.style.score > 0 && result.style.score <= 1);
});

test("toFeatures pulls from the analysis and style results", () => {
  const features = toFeatures({
    analysis: { bpm: 128.4, camelot: "8A", energyLevel: 7 },
    style: { style: "melodic techno", source: "metadata" }
  });
  assert.deepEqual(features, {
    bpm: 128.4,
    camelot: "8A",
    energyLevel: 7,
    style: "melodic techno"
  });
});

test("toFeatures survives a track that failed analysis", () => {
  assert.deepEqual(toFeatures({}), { bpm: null, camelot: null, energyLevel: null, style: null });
  assert.deepEqual(toFeatures(null), { bpm: null, camelot: null, energyLevel: null, style: null });
});

test("totalScore sums the transitions, not the tracks", () => {
  const features = [
    { bpm: 128, camelot: "8A", energyLevel: 5, style: "techno" },
    { bpm: 128, camelot: "8A", energyLevel: 6, style: "techno" },
    { bpm: 128, camelot: "8A", energyLevel: 7, style: "techno" }
  ];
  const total = totalScore(features);
  const pairwise =
    scoreTransition(features[0], features[1]).score + scoreTransition(features[1], features[2]).score;

  assert.equal(total, pairwise);
  assert.equal(totalScore([features[0]]), 0, "a single track has no transitions");
  assert.equal(totalScore([]), 0);
});
