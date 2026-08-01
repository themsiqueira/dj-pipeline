import test from "node:test";
import assert from "node:assert/strict";
import {
  toPipelineError,
  pipelineError,
  looksGeoRestricted,
  PIPELINE_ERROR
} from "../src/pipelineErrors.js";
import { isRetryableToolError } from "../src/concurrency.js";

const SOUNDCLOUD_GEO_STDERR =
  "ERROR: [soundcloud] This video is not available from your location due to geo restriction\n" +
  "You might want to use a VPN or a proxy server (with --proxy) to workaround.";

test("an attached code wins over message parsing", () => {
  const err = pipelineError(PIPELINE_ERROR.PLAYLIST_FETCH, "totally reworded message");
  assert.deepEqual(toPipelineError(err), {
    code: PIPELINE_ERROR.PLAYLIST_FETCH,
    message: "totally reworded message"
  });
});

test("OS and exit codes on `code` are not mistaken for pipeline codes", () => {
  const enoent = new Error("spawn yt-dlp ENOENT");
  enoent.code = "ENOENT";
  assert.equal(toPipelineError(enoent).code, PIPELINE_ERROR.UNKNOWN);

  const exited = new Error("Process exited with code 1");
  exited.code = 1;
  assert.equal(toPipelineError(exited).code, PIPELINE_ERROR.UNKNOWN);
});

test("legacy message matching still classifies untagged errors", () => {
  const cases = [
    ["Cancelled", PIPELINE_ERROR.CANCELLED],
    ["Invalid URL format: foo", PIPELINE_ERROR.INVALID_URL],
    ["Invalid pipeline URL: nope", PIPELINE_ERROR.INVALID_URL],
    ["yt-dlp is not installed or not reachable (yt-dlp).", PIPELINE_ERROR.TOOLS_UNAVAILABLE],
    ["ffmpeg not found at \"/x\".", PIPELINE_ERROR.TOOLS_UNAVAILABLE],
    ["Failed to fetch playlist: boom", PIPELINE_ERROR.PLAYLIST_FETCH],
    ["Failed to fetch video metadata: boom", PIPELINE_ERROR.VIDEO_METADATA],
    ["Spotify credentials missing: set env", PIPELINE_ERROR.SPOTIFY_CREDENTIALS_MISSING],
    ["Spotify resource not found: track x", PIPELINE_ERROR.SPOTIFY_NOT_FOUND],
    ["Spotify API error: 500", PIPELINE_ERROR.SPOTIFY_API],
    ["No YouTube result for: x", PIPELINE_ERROR.YOUTUBE_SEARCH_NO_RESULT],
    ["something else entirely", PIPELINE_ERROR.UNKNOWN]
  ];
  for (const [message, expected] of cases) {
    assert.equal(toPipelineError(new Error(message)).code, expected, message);
  }
});

test("a geo block is recognized from stderr, not just from the message", () => {
  const err = new Error("Process exited with code 1");
  err.stderr = SOUNDCLOUD_GEO_STDERR;
  assert.equal(looksGeoRestricted(err), true);

  assert.equal(looksGeoRestricted(new Error("Process exited with code 1")), false);
  assert.equal(looksGeoRestricted(null), false);
});

test("a geo block outranks the playlist-fetch wrapper it arrives in", () => {
  // yt.js wraps the stderr into this message; the fix is a proxy, not cookies.
  const wrapped = new Error(`Failed to fetch playlist: ${SOUNDCLOUD_GEO_STDERR}\nURL: https://x`);
  assert.equal(toPipelineError(wrapped).code, PIPELINE_ERROR.GEO_RESTRICTED);

  assert.equal(
    toPipelineError(
      new Error(
        "The uploader has not made this video available in your country"
      )
    ).code,
    PIPELINE_ERROR.GEO_RESTRICTED
  );
});

test("a geo block is never retried: every attempt gets the same answer", () => {
  const err = new Error("Process exited with code 1");
  err.stderr = SOUNDCLOUD_GEO_STDERR;
  assert.equal(isRetryableToolError(err), false);
});

test("toPipelineError never returns an empty message", () => {
  assert.equal(toPipelineError(new Error("")).message, "Unknown error");
  assert.equal(toPipelineError(null).message, "Unknown error");
  assert.equal(toPipelineError(undefined).message, "Unknown error");
  assert.equal(toPipelineError("plain string").message, "plain string");
});
