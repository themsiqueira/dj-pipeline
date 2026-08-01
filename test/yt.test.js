import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFlatPlaylistPayload, buildVideoUrl } from "../src/yt.js";

const URL_IN = "https://www.youtube.com/playlist?list=PL1";

test("a populated playlist passes through untouched", () => {
  const data = { title: "My List", entries: [{ id: "a" }, { id: "b" }] };
  assert.equal(normalizeFlatPlaylistPayload(data, URL_IN), data);
});

test("an empty playlist stays empty instead of becoming one bogus track", () => {
  // The top-level `id` here is the playlist id, not a video id.
  const data = { _type: "playlist", id: "PL1", title: "Empty", entries: [] };
  const out = normalizeFlatPlaylistPayload(data, URL_IN);
  assert.deepEqual(out.entries, []);
});

test("a single video is wrapped into a one-entry playlist", () => {
  const data = {
    id: "vid1",
    title: "A Song",
    webpage_url: "https://www.youtube.com/watch?v=vid1",
    uploader: "Someone",
    upload_date: "20200101"
  };
  const out = normalizeFlatPlaylistPayload(data, "https://www.youtube.com/watch?v=vid1");
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].id, "vid1");
  assert.equal(out.entries[0].url, "https://www.youtube.com/watch?v=vid1");
  assert.equal(out.entries[0].uploader, "Someone");
});

test("the resolved media stream url is never used as a page url", () => {
  // yt-dlp puts the googlevideo CDN url in `url`; feeding that back would hit the
  // generic extractor, so the original page url must win.
  const data = {
    id: "vid1",
    title: "A Song",
    url: "https://rr3---sn-x.googlevideo.com/videoplayback?expire=1"
  };
  const out = normalizeFlatPlaylistPayload(data, URL_IN);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].url, URL_IN);
  assert.equal(out.entries[0].webpage_url, URL_IN);
});

test("an unusable payload yields no entries", () => {
  assert.deepEqual(normalizeFlatPlaylistPayload({}, URL_IN).entries, []);
});

test("a non-object payload throws", () => {
  assert.throws(() => normalizeFlatPlaylistPayload(null, URL_IN), /invalid response/);
  assert.throws(() => normalizeFlatPlaylistPayload("nope", URL_IN), /invalid response/);
});

test("buildVideoUrl", () => {
  assert.equal(buildVideoUrl("abc"), "https://www.youtube.com/watch?v=abc");
});
