import test from "node:test";
import assert from "node:assert/strict";
import {
  toCamelot,
  camelotToClassical,
  parseCamelot,
  compatibleKeys,
  keyCompatibility
} from "../src/analysis/camelot.js";

test("toCamelot maps the anchors of the wheel", () => {
  assert.equal(toCamelot("A", "minor"), "8A");
  assert.equal(toCamelot("C", "major"), "8B");
  assert.equal(toCamelot("E", "minor"), "9A");
  assert.equal(toCamelot("G", "major"), "9B");
  assert.equal(toCamelot("F", "major"), "7B");
  assert.equal(toCamelot("D", "minor"), "7A");
});

test("toCamelot accepts enharmonic spellings and Essentia's scale wording", () => {
  assert.equal(toCamelot("F#", "minor"), "11A");
  assert.equal(toCamelot("Gb", "minor"), "11A");
  assert.equal(toCamelot("Bb", "major"), "6B");
  assert.equal(toCamelot("A#", "major"), "6B");
  assert.equal(toCamelot("A", "min"), "8A");
});

test("toCamelot returns null rather than guessing on bad input", () => {
  assert.equal(toCamelot("H", "major"), null);
  assert.equal(toCamelot("", "minor"), null);
  assert.equal(toCamelot("C", ""), null);
  assert.equal(toCamelot(null, null), null);
});

test("every Camelot code round-trips to a classical name", () => {
  for (let n = 1; n <= 12; n += 1) {
    for (const letter of ["A", "B"]) {
      const classical = camelotToClassical(`${n}${letter}`);
      assert.notEqual(classical, "", `${n}${letter} should have a classical name`);
    }
  }
  assert.equal(camelotToClassical("8A"), "Am");
  assert.equal(camelotToClassical("8B"), "C");
  assert.equal(camelotToClassical("11A"), "F#m");
});

test("camelotToClassical yields an empty string for unknown keys so callers can omit the field", () => {
  assert.equal(camelotToClassical(null), "");
  assert.equal(camelotToClassical(""), "");
  assert.equal(camelotToClassical("13A"), "");
});

test("parseCamelot rejects out-of-range wheel positions", () => {
  assert.deepEqual(parseCamelot("8A"), { number: 8, letter: "A" });
  assert.deepEqual(parseCamelot("12b"), { number: 12, letter: "B" });
  assert.equal(parseCamelot("0A"), null);
  assert.equal(parseCamelot("13A"), null);
  assert.equal(parseCamelot("8C"), null);
  assert.equal(parseCamelot(""), null);
});

test("compatibleKeys wraps around the wheel at 12 and 1", () => {
  assert.deepEqual(compatibleKeys("12A").sort(), ["11A", "11B", "12B", "1A", "1B"].sort());
  assert.deepEqual(compatibleKeys("1A").sort(), ["12A", "12B", "1B", "2A", "2B"].sort());
});

test("compatibleKeys returns the five standard moves and never the input itself", () => {
  const neighbours = compatibleKeys("8A");
  assert.equal(neighbours.length, 5);
  assert.ok(!neighbours.includes("8A"));
  assert.deepEqual(neighbours.sort(), ["7A", "7B", "8B", "9A", "9B"].sort());
});

test("keyCompatibility ranks the safe moves above the energy boosts", () => {
  const same = keyCompatibility("8A", "8A");
  const fifthUp = keyCompatibility("8A", "9A");
  const relative = keyCompatibility("8A", "8B");
  const boost = keyCompatibility("8A", "10A");
  const clash = keyCompatibility("8A", "2A");

  assert.equal(same.score, 1);
  assert.ok(fifthUp.score > relative.score);
  assert.ok(relative.score > boost.score);
  assert.ok(boost.score > clash.score);
});

test("keyCompatibility flags the moves that need a short percussive cut", () => {
  assert.equal(keyCompatibility("8A", "10A").energyBoost, true);
  assert.equal(keyCompatibility("8A", "3A").energyBoost, true);
  assert.equal(keyCompatibility("8A", "9A").energyBoost, false);
  assert.equal(keyCompatibility("8A", "8B").energyBoost, false);
});

test("keyCompatibility stays neutral when a key is unknown instead of burying the track", () => {
  assert.equal(keyCompatibility(null, "8A").score, 0.5);
  assert.equal(keyCompatibility("8A", "").score, 0.5);
});

test("fifth-down wraps below 1 without becoming a clash", () => {
  assert.equal(keyCompatibility("1A", "12A").score, 0.95);
  assert.equal(keyCompatibility("12A", "1A").score, 0.95);
});
