import test from "node:test";
import assert from "node:assert/strict";

import { renderSetNotes, formatClock, describeTechnique, describeEffects } from "../src/setlist/notes.js";
import { buildSetOrder } from "../src/setlist/order.js";

function track(spec) {
  return {
    title: spec.title,
    durationSec: spec.durationSec ?? 360,
    analysis: {
      bpm: spec.bpm,
      camelot: spec.camelot,
      keyClassical: spec.classical ?? "Am",
      energyLevel: spec.energy,
      durationSec: spec.durationSec ?? 360,
      cues: spec.cues ?? [
        { name: "Mix in", startSec: 64.5, num: 0 },
        { name: "Drop", startSec: 150, num: 1 },
        { name: "Mix out", startSec: 300, num: 2 }
      ]
    },
    style: spec.style ? { style: spec.style, source: spec.styleSource ?? "metadata" } : null
  };
}

const TRACKS = [
  track({ title: "Opener", bpm: 122, camelot: "8A", energy: 3, style: "melodic techno" }),
  track({ title: "Builder", bpm: 126, camelot: "8A", energy: 6, style: "melodic techno" }),
  track({ title: "Peak", bpm: 130, camelot: "9A", energy: 9, style: "techno" })
];

function notesFor(tracks) {
  const { tracks: ordered, transitions } = buildSetOrder(tracks);
  return renderSetNotes({ tracks: ordered, transitions, playlistName: "Test Set" });
}

test("clock formatting matches how a CDJ displays time", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(64.5), "1:05");
  assert.equal(formatClock(300), "5:00");
  assert.equal(formatClock(3599), "59:59");
  assert.equal(formatClock(-5), "0:00");
  assert.equal(formatClock(null), "0:00");
});

test("every track appears in the running order, numbered", () => {
  const markdown = notesFor(TRACKS);
  for (const t of TRACKS) {
    assert.ok(markdown.includes(t.title), `missing "${t.title}"`);
  }
  assert.ok(markdown.includes("### 1."));
  assert.ok(markdown.includes("### 3."));
  assert.ok(markdown.includes("# Suggested set: Test Set"));
});

test("each track lists its measured tempo, key and energy", () => {
  const markdown = notesFor(TRACKS);
  assert.ok(markdown.includes("122.0 BPM"));
  assert.ok(markdown.includes("8A (Am)"));
  assert.ok(markdown.includes("energy 3/10"));
});

test("an inferred style is labelled as inferred", () => {
  const markdown = notesFor([
    track({ title: "Guessed", bpm: 128, camelot: "8A", energy: 5, style: "techno", styleSource: "inferred" }),
    TRACKS[0]
  ]);
  assert.ok(markdown.includes("techno, inferred"), "an inference must not read as a statement of fact");
});

test("transitions name the actual cue times from the analysis", () => {
  const markdown = notesFor(TRACKS);
  // Mix out at 300s and mix in at 64.5s, as set in the fixture.
  assert.ok(markdown.includes("5:00"), "the outgoing track's Mix out time should be named");
  assert.ok(markdown.includes("1:05"), "the incoming track's Mix in time should be named");
  assert.ok(markdown.includes("Mix out"));
  assert.ok(markdown.includes("Mix in"));
});

test("a track with no cues says so instead of inventing a time", () => {
  const markdown = notesFor([
    track({ title: "Uncued", bpm: 128, camelot: "8A", energy: 4, cues: [] }),
    TRACKS[2]
  ]);
  assert.ok(markdown.includes("none detected"));
  assert.ok(!markdown.includes("undefined"));
  assert.ok(!markdown.includes("NaN"));
});

test("technique follows the measured relationship", () => {
  const easy = describeTechnique({
    key: { score: 1 },
    bpm: { score: 1, percent: 0 },
    energy: { delta: 0 }
  });
  assert.match(easy, /long blend/);

  const clash = describeTechnique({
    key: { score: 0.1 },
    bpm: { score: 1, percent: 0 },
    energy: { delta: 0 }
  });
  assert.match(clash, /short cut|as little as possible/);

  const unmixable = describeTechnique({
    key: { score: 1 },
    bpm: { score: 0.05, percent: 30 },
    energy: { delta: 0 }
  });
  assert.match(unmixable, /too far/);
});

test("effects are justified by something measured", () => {
  const clash = describeEffects({ key: { score: 0.1 }, bpm: { score: 1 }, energy: { delta: 0 } });
  assert.ok(clash.some((e) => /echo/.test(e)), "a key clash should suggest echo cover");

  const lift = describeEffects({ key: { score: 1 }, bpm: { score: 1 }, energy: { delta: 3 } });
  assert.ok(lift.some((e) => /filter/.test(e)), "an energy jump should suggest a filter sweep");

  const clean = describeEffects({ key: { score: 1 }, bpm: { score: 1 }, energy: { delta: 0 } });
  assert.equal(clean.length, 1);
  assert.match(clean[0], /no effects needed/);
});

test("the notes state the limits of what was measured", () => {
  const markdown = notesFor(TRACKS);
  assert.match(markdown, /hint rather than a verdict/i);
});

test("an empty set renders without throwing", () => {
  const markdown = renderSetNotes({ tracks: [], transitions: [], playlistName: "Empty" });
  assert.ok(markdown.includes("nothing to suggest"));
});

test("a single track renders with no transition advice", () => {
  const markdown = notesFor([TRACKS[0]]);
  assert.ok(markdown.includes("Opener"));
  assert.ok(!markdown.includes("Coming from"));
});

test("AI notes are quoted alongside the rule-based advice, not instead of it", () => {
  const { tracks: ordered, transitions } = buildSetOrder(TRACKS);
  const markdown = renderSetNotes({
    tracks: ordered,
    transitions,
    playlistName: "Test",
    aiNotes: new Map([[0, "Ride the high-pass a little longer than feels comfortable."]])
  });

  assert.ok(markdown.includes("> Ride the high-pass"));
  assert.ok(/blend|cut/.test(markdown), "the rule-based technique must still be present");
});

test("markdown has no unresolved placeholders", () => {
  const markdown = notesFor(TRACKS);
  assert.ok(!markdown.includes("undefined"));
  assert.ok(!markdown.includes("null"));
  assert.ok(!markdown.includes("NaN"));
  assert.ok(!markdown.includes("[object Object]"));
});
