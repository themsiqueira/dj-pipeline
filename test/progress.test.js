import test from "node:test";
import assert from "node:assert/strict";
import {
  createProgressModel,
  resolveWeights,
  describeProgress,
  PROGRESS_PHASE
} from "../src/progress.js";
import { PHASE } from "../src/pipeline.js";

test("the phase names match the ones the pipeline emits", () => {
  assert.equal(PROGRESS_PHASE.DOWNLOAD, PHASE.DOWNLOAD);
  assert.equal(PROGRESS_PHASE.SCAN, PHASE.SCAN);
  assert.equal(PROGRESS_PHASE.ANALYZE, PHASE.ANALYZE);
  assert.equal(PROGRESS_PHASE.SET_ORDER, PHASE.SET_ORDER);
});

test("weights always sum to one, whichever phases run", () => {
  const shapes = [
    { source: "url" },
    { source: "url", analyze: true },
    { source: "url", analyze: true, setOrder: true },
    { source: "local" },
    { source: "local", setOrder: true }
  ];

  for (const shape of shapes) {
    const total = Object.values(resolveWeights(shape)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${JSON.stringify(shape)} summed to ${total}`);
  }
});

test("a download-only run reaches 100% without an analysis phase", () => {
  const model = createProgressModel({ source: "url" });

  const { fraction } = model.update({ phase: PHASE.DOWNLOAD, current: 10, total: 10 });

  assert.ok(fraction > 0.99, `expected a full bar, got ${fraction}`);
});

test("downloads stop short of 100% when analysis is still to come", () => {
  const model = createProgressModel({ source: "url", analyze: true, setOrder: true });

  const { fraction } = model.update({ phase: PHASE.DOWNLOAD, current: 10, total: 10 });

  assert.ok(fraction > 0.5 && fraction < 0.9, `expected mid-run, got ${fraction}`);
});

test("the fraction never goes backwards, even when a phase restarts its count", () => {
  const model = createProgressModel({ source: "url", analyze: true, setOrder: true });
  const events = [
    { phase: PHASE.DOWNLOAD, current: 5, total: 10 },
    { phase: PHASE.DOWNLOAD, current: 10, total: 10 },
    { phase: PHASE.ANALYZE, current: 1, total: 10 },
    { phase: PHASE.ANALYZE, current: 10, total: 10 },
    { phase: PHASE.SET_ORDER, current: 0, total: 10 },
    { phase: PHASE.SET_ORDER, current: 10, total: 10 }
  ];

  let previous = 0;
  for (const event of events) {
    const { fraction } = model.update(event);
    assert.ok(fraction >= previous, `${event.phase} ${event.current} went backwards`);
    previous = fraction;
  }
  assert.ok(previous > 0.99, "the last event should land on a full bar");
});

test("out-of-order completions under a worker pool never rewind the bar", () => {
  const model = createProgressModel({ source: "url" });

  const ahead = model.update({ phase: PHASE.DOWNLOAD, current: 8, total: 10 }).fraction;
  const behind = model.update({ phase: PHASE.DOWNLOAD, current: 3, total: 10 }).fraction;

  assert.equal(behind, ahead);
});

test("the fraction stays within bounds for absurd input", () => {
  const model = createProgressModel({ source: "url" });

  for (const event of [
    { phase: PHASE.DOWNLOAD, current: -5, total: 10 },
    { phase: PHASE.DOWNLOAD, current: 0, total: 0 },
    { phase: PHASE.DOWNLOAD, current: NaN, total: 10 },
    { phase: PHASE.DOWNLOAD, current: 999, total: 10 }
  ]) {
    const { fraction } = model.update(event);
    assert.ok(fraction >= 0 && fraction <= 1, `${JSON.stringify(event)} gave ${fraction}`);
  }
});

test("an unknown phase is ignored rather than resetting the bar", () => {
  const model = createProgressModel({ source: "url" });
  const before = model.update({ phase: PHASE.DOWNLOAD, current: 5, total: 10 }).fraction;

  const after = model.update({ phase: "something-else", current: 1, total: 10 }).fraction;

  assert.equal(after, before);
});

test("a URL run is indeterminate until the first count arrives", () => {
  const model = createProgressModel({ source: "url" });

  assert.equal(model.state.indeterminate, true, "listing a playlist has no percentage to report");
  assert.equal(model.update({ phase: PHASE.DOWNLOAD, current: 1, total: 10 }).indeterminate, false);
});

test("a local run knows its size up front, so it is never indeterminate", () => {
  assert.equal(createProgressModel({ source: "local" }).state.indeterminate, false);
});

test("fractional counts are honoured so a single track still moves the bar", () => {
  const model = createProgressModel({ source: "url" });

  const quarter = model.update({ phase: PHASE.DOWNLOAD, current: 0.25, total: 1 }).fraction;
  const half = model.update({ phase: PHASE.DOWNLOAD, current: 0.5, total: 1 }).fraction;

  assert.ok(quarter > 0 && quarter < half && half < 1, `${quarter} then ${half}`);
});

test("finishing the last phase lands on exactly one, not a rounding error short", () => {
  const shapes = [
    { source: "url", last: PHASE.DOWNLOAD },
    { source: "url", analyze: true, last: PHASE.ANALYZE },
    { source: "url", analyze: true, setOrder: true, last: PHASE.SET_ORDER },
    { source: "local", last: PHASE.ANALYZE },
    { source: "local", setOrder: true, last: PHASE.SET_ORDER }
  ];

  for (const { last, ...shape } of shapes) {
    const { fraction } = createProgressModel(shape).update({ phase: last, current: 6, total: 6 });
    assert.equal(fraction, 1, `${JSON.stringify(shape)} stopped at ${fraction}`);
  }
});

test("an earlier phase finishing does not claim the whole bar", () => {
  const model = createProgressModel({ source: "local", setOrder: true });

  const { fraction } = model.update({ phase: PHASE.ANALYZE, current: 6, total: 6 });

  assert.ok(fraction < 1, `set ordering is still to come, got ${fraction}`);
});

test("completing pins the bar at exactly full", () => {
  const model = createProgressModel({ source: "url", analyze: true });
  model.update({ phase: PHASE.DOWNLOAD, current: 3, total: 10 });

  assert.deepEqual(model.complete(), { fraction: 1, indeterminate: false });
});

test("a local run's analysis dominates the bar", () => {
  const weights = resolveWeights({ source: "local" });

  assert.ok(weights[PROGRESS_PHASE.ANALYZE] > 0.9, "there is nothing else to wait for");
  assert.equal(weights[PROGRESS_PHASE.DOWNLOAD], undefined, "nothing is downloaded");
});

test("descriptions name the phase in words a person would use", () => {
  assert.match(describeProgress({ phase: PHASE.DOWNLOAD, current: 3, total: 40, title: "Some Track" }), /Track 3 of 40: Some Track/);
  assert.match(describeProgress({ phase: PHASE.ANALYZE, current: 3, total: 40, title: "Some Track" }), /Analyzing 3 of 40/);
  assert.match(describeProgress({ phase: PHASE.SCAN, current: 2, total: 9 }), /Reading track 2 of 9/);
  assert.match(describeProgress({ phase: PHASE.SET_ORDER }), /set order/i);
});

test("a description never reports a position past the total", () => {
  assert.match(describeProgress({ phase: PHASE.DOWNLOAD, current: 41, total: 40 }), /Track 40 of 40/);
});
