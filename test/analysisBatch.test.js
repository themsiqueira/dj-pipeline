import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { analyzeTracks, resolveAnalysisConcurrency } from "../src/analysis/index.js";

/** A file that exists but is not decodable audio, so analysis fails per-track. */
function makeUndecodableFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdj-analysis-"));
  const file = path.join(dir, "not-audio.mp3");
  fs.writeFileSync(file, "this is not audio");
  return file;
}

test("a track that cannot be analysed does not take the run down", async () => {
  const track = { title: "Broken", filePath: makeUndecodableFile() };
  const lines = [];

  const result = await analyzeTracks([track], { onLog: (l) => lines.push(l) });

  assert.equal(result.analyzed, 0);
  assert.equal(result.failed, 1);
  assert.equal(track.analysis, undefined, "a failed track carries no analysis");
  assert.ok(
    lines.some((l) => l.includes("Broken")),
    "the failure should be reported in the log"
  );
});

test("one bad track does not stop the others from being analysed", async () => {
  const tracks = [
    { title: "Broken", filePath: makeUndecodableFile() },
    { title: "Also broken", filePath: makeUndecodableFile() }
  ];

  const result = await analyzeTracks(tracks, {});

  assert.equal(result.failed, 2, "both should have been attempted");
});

test("an aborted signal stops the phase instead of being swallowed", async () => {
  const controller = new AbortController();
  controller.abort();
  const track = { title: "Cancelled", filePath: makeUndecodableFile() };

  await assert.rejects(() => analyzeTracks([track], { signal: controller.signal }), /Cancelled/);
});

test("tracks with no file on disk are skipped rather than counted as failures", async () => {
  const result = await analyzeTracks([{ title: "Metadata only" }], {});
  assert.deepEqual(result, { analyzed: 0, failed: 0 });
});

test("progress is reported once per track, ending at the total", async () => {
  const tracks = [
    { title: "One", filePath: makeUndecodableFile() },
    { title: "Two", filePath: makeUndecodableFile() }
  ];
  const seen = [];

  await analyzeTracks(tracks, { onProgress: (p) => seen.push(p) });

  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((p) => p.current),
    [1, 2]
  );
  assert.ok(seen.every((p) => p.total === 2));
});

test("analysis concurrency is CPU-sized and independent of the download limit", () => {
  const limit = resolveAnalysisConcurrency();
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 4, `${limit} out of range`);
});
