import test from "node:test";
import assert from "node:assert/strict";
import { createCliReporter } from "../src/cliProgress.js";
import { PHASE } from "../src/pipeline.js";

function fakeStream({ tty = true, columns = 80 } = {}) {
  const writes = [];
  return {
    writes,
    isTTY: tty,
    columns,
    write: (text) => writes.push(text),
    get text() {
      return writes.join("");
    }
  };
}

function reporterOn(streamOptions, shape = { source: "url" }) {
  const stream = fakeStream(streamOptions);
  const logStream = fakeStream({ tty: false });
  return { stream, logStream, reporter: createCliReporter({ stream, logStream, shape, enabled: streamOptions.tty !== false }) };
}

test("nothing is drawn when stderr is not a terminal", () => {
  const { stream, logStream, reporter } = reporterOn({ tty: false });

  reporter.progress({ phase: PHASE.DOWNLOAD, current: 1, total: 4, title: "A track" });
  reporter.progress({ phase: PHASE.DOWNLOAD, current: 2, total: 4, title: "A track" });
  reporter.log("a log line");

  assert.equal(stream.writes.length, 0, "a piped run must stay free of escape codes");
  assert.equal(logStream.text, "a log line\n");
});

test("a piped run still prints the closing message", () => {
  const { stream, logStream, reporter } = reporterOn({ tty: false });

  reporter.finish("Done");

  assert.equal(stream.writes.length, 0);
  assert.equal(logStream.text, "Done\n");
});

test("the bar is drawn on a terminal and carries the percentage", () => {
  const { stream, reporter } = reporterOn({ tty: true });

  reporter.progress({ phase: PHASE.DOWNLOAD, current: 4, total: 4, title: "Last" });

  assert.match(stream.text, /100%/);
  assert.match(stream.text, /█/);
});

test("redraws are throttled to about ten a second", () => {
  const { stream, reporter } = reporterOn({ tty: true });

  for (let i = 0; i < 200; i += 1) {
    reporter.progress({ phase: PHASE.DOWNLOAD, current: i / 200, total: 1, title: "x" });
  }

  assert.ok(stream.writes.length <= 3, `expected a handful of frames, got ${stream.writes.length}`);
});

test("each frame erases the previous one instead of appending", () => {
  const { stream, reporter } = reporterOn({ tty: true });

  reporter.progress({ phase: PHASE.DOWNLOAD, current: 1, total: 4, title: "A" });

  assert.ok(stream.writes.every((w) => w.startsWith("\r\u001b[2K")), "every frame should start by clearing the line");
  assert.ok(!stream.text.includes("\n"), "the bar must stay on one line");
});

test("a log line steps the bar aside and puts it back", () => {
  const { stream, logStream, reporter } = reporterOn({ tty: true });
  reporter.progress({ phase: PHASE.DOWNLOAD, current: 1, total: 4, title: "A" });
  const framesBefore = stream.writes.length;

  reporter.log("Saved: /tmp/a.mp3");

  assert.equal(logStream.text, "Saved: /tmp/a.mp3\n");
  assert.ok(stream.writes.length > framesBefore, "the bar should be erased and redrawn around the log line");
  assert.ok(stream.writes[framesBefore].startsWith("\r\u001b[2K"));
});

test("a log line before any progress draws no bar", () => {
  const { stream, reporter } = reporterOn({ tty: true });

  reporter.log("Playlist: Something");

  assert.equal(stream.writes.length, 0, "there is nothing to redraw yet");
});

test("finishing draws a full bar and releases the line", () => {
  const { stream, reporter } = reporterOn({ tty: true });
  reporter.progress({ phase: PHASE.DOWNLOAD, current: 1, total: 10, title: "A" });

  reporter.finish("Done");

  assert.match(stream.text, /100%/, "the run ended, so the bar should say so");
  assert.ok(stream.text.endsWith("\n"), "the shell prompt needs its line back");
});

test("clearing removes the bar without claiming success", () => {
  const { stream, reporter } = reporterOn({ tty: true });
  reporter.progress({ phase: PHASE.DOWNLOAD, current: 1, total: 10, title: "A" });

  reporter.clear();

  assert.ok(!/100%/.test(stream.text), "a cancelled run must not report a full bar");
  assert.ok(stream.writes.at(-1).startsWith("\r\u001b[2K"));
});

test("a long title is truncated rather than wrapped", () => {
  const { stream, reporter } = reporterOn({ tty: true, columns: 40 });

  reporter.progress({ phase: PHASE.DOWNLOAD, current: 1, total: 4, title: "x".repeat(300) });

  for (const frame of stream.writes) {
    assert.ok(frame.replace("\r\u001b[2K", "").length <= 39, "a wrapped bar leaves the old frame stranded above");
  }
});

test("the label follows the phase", () => {
  const { stream, reporter } = reporterOn({ tty: true }, { source: "local" });

  reporter.progress({ phase: PHASE.ANALYZE, current: 2, total: 5, title: "Night Drive" });

  assert.match(stream.text, /Analyzing 2 of 5/);
});
