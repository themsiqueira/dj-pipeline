import test from "node:test";
import assert from "node:assert/strict";
import { detectStructure, CUE_TYPE, MEMORY_CUE, HOT_CUE_A, HOT_CUE_B, HOT_CUE_C } from "../src/analysis/structure.js";
import { computeEnergyBands, estimateEnergyLevel, median } from "../src/analysis/energy.js";

const FRAME = 0.1;

/**
 * Build band envelopes for a track laid out as a list of
 * `{ seconds, low, broad, high }` sections, so tests describe arrangements
 * rather than frame indices.
 */
function bandsFromSections(sections) {
  const frames = [];
  for (const section of sections) {
    const count = Math.round(section.seconds / FRAME);
    for (let i = 0; i < count; i += 1) {
      frames.push(section);
    }
  }
  return {
    frameSeconds: FRAME,
    low: Float32Array.from(frames, (f) => f.low),
    broad: Float32Array.from(frames, (f) => f.broad),
    high: Float32Array.from(frames, (f) => f.high)
  };
}

/** 128 BPM: 0.46875s per beat, 1.875s per bar, 60s per 32-bar phrase. */
const BPM = 128;
const SECONDS_PER_BAR = (60 / BPM) * 4;

function beatsFor(durationSec, offset = 0) {
  const beats = [];
  for (let t = offset; t < durationSec; t += 60 / BPM) beats.push(t);
  return beats;
}

/** intro 32 bars, main 32, breakdown 16, drop 32, outro 16 */
function typicalTrack() {
  return bandsFromSections([
    { seconds: SECONDS_PER_BAR * 32, low: 0.5, broad: 0.6, high: 0.1 },
    { seconds: SECONDS_PER_BAR * 32, low: 0.5, broad: 0.8, high: 0.3 },
    { seconds: SECONDS_PER_BAR * 16, low: 0.02, broad: 0.5, high: 0.3 },
    { seconds: SECONDS_PER_BAR * 32, low: 0.6, broad: 0.9, high: 0.35 },
    { seconds: SECONDS_PER_BAR * 16, low: 0.4, broad: 0.5, high: 0.1 }
  ]);
}

const TRACK_DURATION = SECONDS_PER_BAR * 128;

test("a typical arrangement yields the three hot cues a DJ mixes with", () => {
  const bands = typicalTrack();
  const result = detectStructure({
    bands,
    beats: beatsFor(TRACK_DURATION),
    bpm: BPM,
    durationSec: TRACK_DURATION
  });

  const nums = result.cues.map((c) => c.num);
  assert.ok(nums.includes(HOT_CUE_A), "expected a mix-in hot cue");
  assert.ok(nums.includes(HOT_CUE_B), "expected a drop hot cue");
  assert.ok(nums.includes(HOT_CUE_C), "expected a mix-out hot cue");
});

test("the drop lands where the kick returns after the breakdown", () => {
  const bands = typicalTrack();
  const result = detectStructure({
    bands,
    beats: beatsFor(TRACK_DURATION),
    bpm: BPM,
    durationSec: TRACK_DURATION
  });

  const drop = result.cues.find((c) => c.num === HOT_CUE_B);
  const breakdownEnd = SECONDS_PER_BAR * 80;
  assert.ok(drop, "expected a drop cue");
  assert.ok(
    Math.abs(drop.startSec - breakdownEnd) <= SECONDS_PER_BAR * 8,
    `drop at ${drop.startSec}s should be within 8 bars of the breakdown end at ${breakdownEnd}s`
  );
});

test("every cue is snapped to the phrase grid", () => {
  const bands = typicalTrack();
  const result = detectStructure({
    bands,
    beats: beatsFor(TRACK_DURATION),
    bpm: BPM,
    durationSec: TRACK_DURATION
  });

  for (const cue of result.cues) {
    const barsFromDownbeat = (cue.startSec - result.firstDownbeatSec) / SECONDS_PER_BAR;
    const distanceToBar = Math.abs(barsFromDownbeat - Math.round(barsFromDownbeat));
    assert.ok(
      distanceToBar < 0.02,
      `${cue.name} at ${cue.startSec}s is ${distanceToBar} bars off the grid`
    );
  }
});

test("cues stay inside the track and in ascending order", () => {
  const bands = typicalTrack();
  const result = detectStructure({
    bands,
    beats: beatsFor(TRACK_DURATION),
    bpm: BPM,
    durationSec: TRACK_DURATION
  });

  let previous = -1;
  for (const cue of result.cues) {
    assert.ok(cue.startSec >= 0, `${cue.name} is before the start`);
    assert.ok(cue.startSec <= TRACK_DURATION, `${cue.name} is past the end`);
    assert.ok(cue.startSec > previous, "cues should be strictly ascending after dedupe");
    previous = cue.startSec;
  }
});

test("no two cues share a position", () => {
  const bands = typicalTrack();
  const result = detectStructure({
    bands,
    beats: beatsFor(TRACK_DURATION),
    bpm: BPM,
    durationSec: TRACK_DURATION
  });

  const positions = result.cues.map((c) => c.startSec.toFixed(2));
  assert.equal(new Set(positions).size, positions.length);
});

/**
 * Regression: a kick is a transient, so most 100 ms frames in a "kicking"
 * section sit in the decay between hits. Judging kick presence from raw
 * per-frame RMS made the median describe the gaps, and every breakdown went
 * undetected on real audio even though flat-envelope fixtures passed.
 */
test("a pulsing kick is still recognised as present between hits", () => {
  const frames = [];
  const framesPerBeat = Math.round(60 / BPM / FRAME);
  const pushSection = (seconds, { kicking, pad }) => {
    const count = Math.round(seconds / FRAME);
    for (let i = 0; i < count; i += 1) {
      const onKick = kicking && frames.length % framesPerBeat === 0;
      frames.push({
        low: onKick ? 0.35 : pad ? 0.09 : 0.004,
        broad: pad ? 0.27 : onKick ? 0.35 : 0.01,
        high: pad ? 0.02 : 0.001
      });
    }
  };

  pushSection(SECONDS_PER_BAR * 32, { kicking: true, pad: true });
  pushSection(SECONDS_PER_BAR * 16, { kicking: false, pad: true });
  pushSection(SECONDS_PER_BAR * 48, { kicking: true, pad: true });

  const duration = SECONDS_PER_BAR * 96;
  const bands = {
    frameSeconds: FRAME,
    low: Float32Array.from(frames, (f) => f.low),
    broad: Float32Array.from(frames, (f) => f.broad),
    high: Float32Array.from(frames, (f) => f.high)
  };

  const result = detectStructure({ bands, beats: beatsFor(duration), bpm: BPM, durationSec: duration });

  const drop = result.cues.find((c) => c.num === HOT_CUE_B);
  assert.ok(drop, "the breakdown between the kicking sections should produce a drop cue");
  assert.ok(
    Math.abs(drop.startSec - SECONDS_PER_BAR * 48) <= SECONDS_PER_BAR * 8,
    `drop at ${drop.startSec}s should be near the kick returning at ${SECONDS_PER_BAR * 48}s`
  );
});

test("a clip too short for a 32-bar intro gets no mix cues past its end", () => {
  const duration = 19;
  const bands = bandsFromSections([{ seconds: duration, low: 0.4, broad: 0.6, high: 0.2 }]);
  const result = detectStructure({ bands, beats: beatsFor(duration), bpm: BPM, durationSec: duration });

  assert.ok(!result.cues.some((c) => c.num === HOT_CUE_A), "a mix-in at the end is useless");
  assert.ok(!result.cues.some((c) => c.num === HOT_CUE_C));
  assert.ok(result.cues.length >= 1, "should still offer a load point");
  for (const cue of result.cues) {
    assert.ok(cue.startSec < duration, `${cue.name} at ${cue.startSec}s is past the end`);
  }
});

test("sections are ordered and stay inside the track", () => {
  const bands = typicalTrack();
  const result = detectStructure({
    bands,
    beats: beatsFor(TRACK_DURATION),
    bpm: BPM,
    durationSec: TRACK_DURATION
  });

  let previousStart = -1;
  for (const section of result.sections) {
    assert.ok(section.startSec >= previousStart, "sections should be in chronological order");
    assert.ok(section.endSec >= section.startSec, `${section.label} ends before it starts`);
    assert.ok(section.endSec <= TRACK_DURATION + 0.01, `${section.label} runs past the track`);
    previousStart = section.startSec;
  }
});

test("a track with no detected tempo still gets a usable start cue", () => {
  const bands = typicalTrack();
  const result = detectStructure({ bands, beats: [], bpm: null, durationSec: TRACK_DURATION });

  assert.equal(result.firstDownbeatSec, null);
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].num, MEMORY_CUE);
  assert.equal(result.cues[0].type, CUE_TYPE.CUE);
});

test("a track with no breakdown produces no drop cue rather than a fabricated one", () => {
  const bands = bandsFromSections([
    { seconds: SECONDS_PER_BAR * 96, low: 0.5, broad: 0.8, high: 0.3 }
  ]);
  const duration = SECONDS_PER_BAR * 96;
  const result = detectStructure({ bands, beats: beatsFor(duration), bpm: BPM, durationSec: duration });

  assert.ok(!result.cues.some((c) => c.num === HOT_CUE_B), "should not invent a drop");
  assert.ok(result.cues.some((c) => c.num === HOT_CUE_A), "mix-in should still be present");
});

test("a silent tail does not drag the outro cue past the music", () => {
  const music = SECONDS_PER_BAR * 64;
  const bands = bandsFromSections([
    { seconds: music, low: 0.5, broad: 0.8, high: 0.3 },
    { seconds: 30, low: 0, broad: 0, high: 0 }
  ]);
  const duration = music + 30;
  const result = detectStructure({ bands, beats: beatsFor(duration), bpm: BPM, durationSec: duration });

  for (const cue of result.cues) {
    assert.ok(cue.startSec <= music + 1, `${cue.name} at ${cue.startSec}s landed in the silence`);
  }
});

test("computeEnergyBands separates a sub-bass tone from a high tone", () => {
  const sampleRate = 44100;
  const seconds = 2;
  const low = new Float32Array(sampleRate * seconds);
  const high = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < low.length; i += 1) {
    low[i] = Math.sin((2 * Math.PI * 50 * i) / sampleRate);
    high[i] = Math.sin((2 * Math.PI * 9000 * i) / sampleRate);
  }

  const lowBands = computeEnergyBands(low, sampleRate);
  const highBands = computeEnergyBands(high, sampleRate);

  assert.ok(median(lowBands.low) > median(lowBands.high) * 10, "50 Hz should be dominated by the low band");
  assert.ok(median(highBands.high) > median(highBands.low) * 10, "9 kHz should be dominated by the high band");
});

test("estimateEnergyLevel stays in range and ranks a loud kicky track above a quiet one", () => {
  const quiet = bandsFromSections([{ seconds: 10, low: 0.005, broad: 0.01, high: 0.002 }]);
  const loud = bandsFromSections([{ seconds: 10, low: 0.5, broad: 0.7, high: 0.25 }]);

  const quietLevel = estimateEnergyLevel(quiet);
  const loudLevel = estimateEnergyLevel(loud);

  for (const level of [quietLevel, loudLevel]) {
    assert.ok(Number.isInteger(level) && level >= 1 && level <= 10, `${level} out of range`);
  }
  assert.ok(loudLevel > quietLevel);
});

test("estimateEnergyLevel survives digital silence", () => {
  const silent = bandsFromSections([{ seconds: 5, low: 0, broad: 0, high: 0 }]);
  assert.equal(estimateEnergyLevel(silent), 1);
});
