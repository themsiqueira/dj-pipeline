import test from "node:test";
import assert from "node:assert/strict";
import { parseSoundCloudPageMeta, metaFromSoundCloudUrl } from "../src/soundcloudPage.js";

const PAGE_URL = "https://soundcloud.com/thechemicalbrothers/hey-boy-hey-girl";

// Trimmed from the real page, which still serves these tags while the track itself is
// geo-blocked.
const PAGE_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Hey Boy Hey Girl" />
<meta property="og:description" content="Listen to Hey Boy Hey Girl by The Chemical Brothers #np on #SoundCloud" />
<meta property="og:url" content="${PAGE_URL}" />
</head><body><script>window.__sc_hydration = [{"hydratable":"sound","data":{
"duration":290493,"full_duration":290493,"title":"Hey Boy Hey Girl",
"user":{"username":"The Chemical Brothers"}}}]</script></body></html>`;

test("a blocked page still yields everything a YouTube search needs", () => {
  assert.deepEqual(parseSoundCloudPageMeta(PAGE_HTML, PAGE_URL), {
    title: "Hey Boy Hey Girl",
    artist: "The Chemical Brothers",
    durationMs: 290493
  });
});

test("html entities in the title are decoded", () => {
  const html =
    '<meta property="og:title" content="Rock &amp; Roll (Isn&#x27;t Noise)" />' +
    '<meta property="og:description" content="Listen to x by Some &amp; Artist #np on #SoundCloud" />';
  const meta = parseSoundCloudPageMeta(html, PAGE_URL);
  assert.equal(meta.title, "Rock & Roll (Isn't Noise)");
  assert.equal(meta.artist, "Some & Artist");
});

test("the uploader is used when the description is not SoundCloud's own wording", () => {
  const html =
    '<meta property="og:title" content="Untitled Jam" />' +
    '<meta property="og:description" content="recorded live, no edits" />' +
    '{"username":"Some DJ"}';
  const meta = parseSoundCloudPageMeta(html, PAGE_URL);
  assert.equal(meta.artist, "Some DJ");
});

test("full_duration wins over a 30 s preview duration", () => {
  const html = '{"duration":30000,"full_duration":412000}';
  assert.equal(parseSoundCloudPageMeta(html, PAGE_URL).durationMs, 412000);
});

test("an unreadable page falls back to the track slug", () => {
  const meta = parseSoundCloudPageMeta("", PAGE_URL);
  assert.equal(meta.title, "hey boy hey girl");
  assert.equal(meta.artist, "");
  assert.equal(meta.durationMs, 0);
});

test("the user slug is never used as a title: it cannot be split into words", () => {
  assert.equal(metaFromSoundCloudUrl(PAGE_URL).title, "hey boy hey girl");
  assert.equal(metaFromSoundCloudUrl("not a url").title, "");
});
