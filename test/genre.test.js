import test from "node:test";
import assert from "node:assert/strict";

import { detectStyle, styleAffinity, knownStyles } from "../src/analysis/genre.js";

test("specific styles win over their parent genre", () => {
  assert.equal(detectStyle({ title: "Melodic Techno Mix 2024" }).style, "melodic techno");
  assert.equal(detectStyle({ title: "Tech House Banger" }).style, "tech house");
  assert.equal(detectStyle({ title: "HARD TECHNO 150 BPM" }).style, "hard techno");
  assert.equal(detectStyle({ title: "Deep House Session" }).style, "deep house");
  assert.equal(detectStyle({ title: "Progressive Trance Classics" }).style, "progressive trance");
});

test("falls back to the parent genre when no subgenre is named", () => {
  assert.equal(detectStyle({ title: "Techno Set - Live" }).style, "techno");
  assert.equal(detectStyle({ title: "House Party Mix" }).style, "house");
});

test("real upload titles classify correctly", () => {
  // Sampled from actual yt-dlp output: tags empty, genre absent, only the title carries it.
  assert.equal(
    detectStyle({ title: "Minimal Techno , 128 bpm", uploader: "Schweiger System", tags: [] }).style,
    "minimal techno"
  );
  assert.equal(
    detectStyle({ title: "House / techno drum loops 128 BPM // The Hybrid Drummer" }).style,
    "house"
  );
});

test("separators and punctuation do not block matching", () => {
  assert.equal(detectStyle({ title: "MELODIC-TECHNO" }).style, "melodic techno");
  assert.equal(detectStyle({ title: "Drum&Bass Rollers" }).style, "drum and bass");
  assert.equal(detectStyle({ title: "Liquid D&B" }).style, "drum and bass");
  assert.equal(detectStyle({ title: "(Tech House) Groove" }).style, "tech house");
});

test("style words inside longer words do not match", () => {
  assert.equal(detectStyle({ title: "Housekeeping Blues" }).style, null);
  assert.equal(detectStyle({ title: "Technology Podcast" }).style, null);
});

test("metadata fields are ranked by how much they can be trusted", () => {
  // A SoundCloud genre field beats a passing mention in the description.
  const result = detectStyle({
    genre: "Tech House",
    description: "follow my techno page"
  });
  assert.equal(result.style, "tech house");
  assert.equal(result.evidence, "genre");

  // Title beats tags, because tags drift off-topic.
  const titleWins = detectStyle({
    title: "Melodic Techno Journey",
    tags: ["deep house", "chill"]
  });
  assert.equal(titleWins.style, "melodic techno");
  assert.equal(titleWins.evidence, "title");
});

test("tags and description are used when the title says nothing", () => {
  assert.equal(detectStyle({ title: "ID - ID", tags: ["afro house", "summer"] }).style, "afro house");
  assert.equal(
    detectStyle({ title: "Untitled", description: "A dub techno excursion." }).style,
    "dub techno"
  );
});

test("a metadata match is asserted, not inferred", () => {
  const result = detectStyle({ title: "Peak Time Techno", bpm: 128, energyLevel: 9 });
  assert.equal(result.source, "metadata");
  assert.ok(result.confidence >= 0.9);
});

test("features infer only a broad family, and say so", () => {
  const result = detectStyle({ title: "ID - ID", bpm: 174, energyLevel: 8 });
  assert.equal(result.style, "drum and bass");
  assert.equal(result.source, "inferred");
  assert.equal(result.evidence, "bpm+energy");
  assert.ok(result.confidence < 0.5, "an inference must not outrank a stated genre");
});

test("features never infer a subgenre they cannot hear the difference of", () => {
  // 125-128 covers tech house, melodic techno and progressive house alike.
  // Only the coarse family is honest at that tempo.
  const coarse = new Set(["house", "techno"]);
  for (const bpm of [124, 126, 128]) {
    for (const energyLevel of [3, 5, 8, 10]) {
      const { style } = detectStyle({ title: "ID", bpm, energyLevel });
      assert.ok(coarse.has(style), `${bpm} BPM at energy ${energyLevel} inferred "${style}"`);
    }
  }
});

test("energy separates house from techno in the shared tempo range", () => {
  assert.equal(detectStyle({ title: "ID", bpm: 126, energyLevel: 4 }).style, "house");
  assert.equal(detectStyle({ title: "ID", bpm: 126, energyLevel: 9 }).style, "techno");
});

test("tempo families cover the range", () => {
  assert.equal(detectStyle({ title: "ID", bpm: 75 }).style, "downtempo");
  assert.equal(detectStyle({ title: "ID", bpm: 118 }).style, "house");
  assert.equal(detectStyle({ title: "ID", bpm: 138 }).style, "techno");
  assert.equal(detectStyle({ title: "ID", bpm: 150, energyLevel: 9 }).style, "hard techno");
  assert.equal(detectStyle({ title: "ID", bpm: 200 }).style, "hardcore");
});

test("nothing at all yields unknown rather than a guess", () => {
  const result = detectStyle({ title: "ID - ID" });
  assert.equal(result.style, null);
  assert.equal(result.source, "unknown");
  assert.equal(result.confidence, 0);
});

test("missing input does not throw", () => {
  assert.equal(detectStyle().style, null);
  assert.equal(detectStyle({}).source, "unknown");
  assert.equal(detectStyle({ tags: null, description: undefined }).style, null);
});

test("style affinity ranks same, sibling, adjacent and distant styles", () => {
  const same = styleAffinity("tech house", "tech house");
  const sibling = styleAffinity("tech house", "deep house");
  const adjacent = styleAffinity("melodic techno", "techno");
  const distant = styleAffinity("hard techno", "ambient");

  assert.ok(same > sibling, "identical should beat sibling");
  assert.ok(sibling > adjacent, "sibling should beat adjacent");
  assert.ok(adjacent > distant, "adjacent should beat distant");
});

test("style affinity is symmetric and safe on unknown styles", () => {
  assert.equal(styleAffinity("techno", "house"), styleAffinity("house", "techno"));
  assert.equal(styleAffinity(null, "techno"), styleAffinity("techno", null));
  assert.ok(styleAffinity(null, null) > 0, "unknown styles must not veto a transition");
});

test("every grouped style is a canonical name", () => {
  const canonical = new Set(knownStyles());
  for (const name of knownStyles()) {
    assert.ok(canonical.has(name));
  }
  // Guards against a typo in the affinity table silently degrading every pairing.
  assert.notEqual(styleAffinity("melodic techno", "melodic house"), 0.6);
});
