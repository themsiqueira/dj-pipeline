import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPipelineUrl,
  assertValidPipelineUrl,
  siteFromHostname,
  isYouTubeUrl,
  isSpotifyPipelineUrl
} from "../src/urlPolicy.js";
import { PIPELINE_ERROR } from "../src/pipelineErrors.js";

test("siteFromHostname recognises the supported hosts", () => {
  assert.equal(siteFromHostname("www.youtube.com"), "youtube");
  assert.equal(siteFromHostname("youtu.be"), "youtube");
  assert.equal(siteFromHostname("music.youtube.com"), "youtube");
  assert.equal(siteFromHostname("soundcloud.com"), "soundcloud");
  assert.equal(siteFromHostname("open.spotify.com"), "spotify");
  assert.equal(siteFromHostname("example.com"), "unknown");
});

test("siteFromHostname is not fooled by a lookalike suffix", () => {
  assert.equal(siteFromHostname("notyoutube.com.evil.test"), "unknown");
  assert.equal(siteFromHostname(""), "unknown");
});

test("classifyPipelineUrl separates playlists from single tracks", () => {
  assert.deepEqual(classifyPipelineUrl("https://www.youtube.com/playlist?list=PL123"), {
    site: "youtube",
    mode: "playlist"
  });
  assert.deepEqual(classifyPipelineUrl("https://www.youtube.com/watch?v=abc"), {
    site: "youtube",
    mode: "single"
  });
  assert.deepEqual(classifyPipelineUrl("https://youtu.be/abc"), {
    site: "youtube",
    mode: "single"
  });
  assert.deepEqual(classifyPipelineUrl("https://www.youtube.com/shorts/abc"), {
    site: "youtube",
    mode: "single"
  });
  assert.deepEqual(classifyPipelineUrl("https://soundcloud.com/artist/sets/my-set"), {
    site: "soundcloud",
    mode: "playlist"
  });
  assert.deepEqual(classifyPipelineUrl("https://soundcloud.com/artist/a-track"), {
    site: "soundcloud",
    mode: "single"
  });
});

test("classifyPipelineUrl handles Spotify URLs, URIs, and intl prefixes", () => {
  assert.deepEqual(classifyPipelineUrl("https://open.spotify.com/album/1a2b3c"), {
    site: "spotify",
    mode: "playlist"
  });
  assert.deepEqual(classifyPipelineUrl("https://open.spotify.com/intl-pt/track/1a2b3c"), {
    site: "spotify",
    mode: "single"
  });
  assert.deepEqual(classifyPipelineUrl("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), {
    site: "spotify",
    mode: "playlist"
  });
  assert.deepEqual(classifyPipelineUrl("spotify:track:37i9dQZF1DXcBWIGoYBM5M"), {
    site: "spotify",
    mode: "single"
  });
});

test("classifyPipelineUrl degrades to unknown/single on garbage", () => {
  assert.deepEqual(classifyPipelineUrl("not a url"), { site: "unknown", mode: "single" });
  assert.deepEqual(classifyPipelineUrl(null), { site: "unknown", mode: "single" });
});

test("assertValidPipelineUrl accepts supported sources", () => {
  assert.doesNotThrow(() => assertValidPipelineUrl("https://www.youtube.com/watch?v=abc"));
  assert.doesNotThrow(() => assertValidPipelineUrl("https://soundcloud.com/a/b"));
  assert.doesNotThrow(() => assertValidPipelineUrl("spotify:album:37i9dQZF1DXcBWIGoYBM5M"));
});

test("assertValidPipelineUrl rejects with an INVALID_URL code, not just a message", () => {
  for (const bad of ["https://example.com/x", "nonsense", ""]) {
    assert.throws(
      () => assertValidPipelineUrl(bad),
      (err) => err.code === PIPELINE_ERROR.INVALID_URL,
      `expected INVALID_URL for ${JSON.stringify(bad)}`
    );
  }
});

test("isYouTubeUrl / isSpotifyPipelineUrl", () => {
  assert.equal(isYouTubeUrl("https://youtu.be/abc"), true);
  assert.equal(isYouTubeUrl("https://soundcloud.com/a/b"), false);
  assert.equal(isYouTubeUrl("garbage"), false);
  assert.equal(isSpotifyPipelineUrl("spotify:track:37i9dQZF1DXcBWIGoYBM5M"), true);
  assert.equal(isSpotifyPipelineUrl("https://open.spotify.com/track/x"), true);
  assert.equal(isSpotifyPipelineUrl("https://youtu.be/abc"), false);
});
