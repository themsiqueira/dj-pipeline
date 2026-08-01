import test from "node:test";
import assert from "node:assert/strict";
import { needsWiderSearch, closestByDuration } from "../src/youtubeSearch.js";

// Real ytsearch3 results for "The Chemical Brothers Hey Boy Hey Girl"; the SoundCloud
// original runs 290 s, and the top hit is the 3:39 video edit.
const HEY_BOY_HEY_GIRL = 290;
const RESULTS = [
  { id: "tpKCqp9CALQ", url: "https://www.youtube.com/watch?v=tpKCqp9CALQ", duration: 219 },
  { id: "u54YG1iOkKQ", url: "https://www.youtube.com/watch?v=u54YG1iOkKQ", duration: 291 },
  { id: "CLuLAL9-VIo", url: "https://www.youtube.com/watch?v=CLuLAL9-VIo", duration: 368 }
];

test("a radio edit of the right song still triggers a wider search", () => {
  assert.equal(needsWiderSearch(RESULTS[0], HEY_BOY_HEY_GIRL), true);
});

test("a length that already fits costs only one search", () => {
  assert.equal(needsWiderSearch({ duration: 291 }, HEY_BOY_HEY_GIRL), false);
  assert.equal(needsWiderSearch({ duration: 300 }, HEY_BOY_HEY_GIRL), false);
});

test("an unknown duration on either side cannot justify a second search", () => {
  assert.equal(needsWiderSearch({ duration: 219 }, 0), false);
  assert.equal(needsWiderSearch({ duration: 0 }, HEY_BOY_HEY_GIRL), false);
  assert.equal(needsWiderSearch(null, HEY_BOY_HEY_GIRL), false);
});

test("the wider search picks the full version over the edit and the extended mix", () => {
  assert.equal(closestByDuration(RESULTS, HEY_BOY_HEY_GIRL).id, "u54YG1iOkKQ");
});

test("nothing within tolerance yields no pick rather than a wrong one", () => {
  const hourLongMixes = [{ id: "a", duration: 3600 }, { id: "b", duration: 4200 }];
  assert.equal(closestByDuration(hourLongMixes, HEY_BOY_HEY_GIRL), null);
  assert.equal(closestByDuration([], HEY_BOY_HEY_GIRL), null);
});

test("results without a duration never win over one that matches", () => {
  const mixed = [{ id: "unknown", duration: 0 }, { id: "match", duration: 288 }];
  assert.equal(closestByDuration(mixed, HEY_BOY_HEY_GIRL).id, "match");
});
