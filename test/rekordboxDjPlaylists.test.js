import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { create } from "xmlbuilder2";
import {
  buildRekordboxXml,
  toRekordboxLocation,
  toRekordboxRating
} from "../src/rekordboxDjPlaylists.js";

const OUT = path.join(os.tmpdir(), "ytdj-test-xml", "rekordbox.xml");

function makeTrack(overrides = {}) {
  return {
    trackId: 1,
    title: "Track One",
    artist: "Artist",
    album: "Album",
    trackNumber: 1,
    filePath: "/music/Track One.mp3",
    analysis: {
      durationSec: 360.4,
      sampleRate: 44100,
      bpm: 128.02,
      keyClassical: "Am",
      camelot: "8A",
      firstDownbeatSec: 0.482,
      cues: [
        { name: "Mix in", type: 0, num: 0, startSec: 60.5 },
        { name: "Drop", type: 0, num: 1, startSec: 150.25 },
        { name: "Breakdown", type: 0, num: -1, startSec: 120 }
      ]
    },
    ...overrides
  };
}

function build(tracks, options = {}) {
  return buildRekordboxXml({
    tracks,
    playlistName: "My Set",
    outputXmlPath: OUT,
    ...options
  });
}

test("percent-encodes the characters that break Rekordbox path lookup", () => {
  const location = toRekordboxLocation("/music/Track #5 100% (Remix).mp3");
  assert.ok(location.startsWith("file://localhost/"), "should use the localhost form");
  assert.ok(location.includes("%23"), "# must be encoded or it becomes a URL fragment");
  assert.ok(location.includes("%25"), "% must be encoded");
  assert.ok(location.includes("%20"), "spaces must be encoded");
  assert.ok(!location.includes("#"), "no raw # may survive");
});

test("leaves the characters Rekordbox's own exports leave alone", () => {
  const location = toRekordboxLocation("/music/Catacombs (VIP Bootleg) - Ternion Sound, LOST.mp3");
  assert.ok(location.includes("("), "parentheses stay literal");
  assert.ok(location.includes(","), "commas stay literal");
});

test("normalizes decomposed macOS filenames so accented titles resolve", () => {
  const decomposed = "/music/Cafe\u0301 del Mar.mp3";
  const composed = "/music/Caf\u00e9 del Mar.mp3";
  assert.equal(toRekordboxLocation(decomposed), toRekordboxLocation(composed));
});

test("ratings use Rekordbox's 0/51/.../255 scale rather than 0-5", () => {
  assert.equal(toRekordboxRating(0), 0);
  assert.equal(toRekordboxRating(3), 153);
  assert.equal(toRekordboxRating(5), 255);
  assert.equal(toRekordboxRating(9), 255);
  assert.equal(toRekordboxRating(-1), 0);
});

test("every track carries TotalTime, without which Rekordbox silently drops its cues", () => {
  const xml = build([makeTrack(), makeTrack({ trackId: 2, analysis: null, durationSec: 200 })]);
  const totalTimes = xml.match(/TotalTime="(\d+)"/g) ?? [];
  assert.equal(totalTimes.length, 2);
  assert.ok(xml.includes('TotalTime="360"'), "should round the analysed duration to whole seconds");
  assert.ok(xml.includes('TotalTime="200"'), "should fall back to the track duration");
});

test("cue points become POSITION_MARK elements with the documented Num values", () => {
  const xml = build([makeTrack()]);
  assert.ok(xml.includes('<POSITION_MARK Name="Mix in" Type="0" Start="60.500" Num="0"/>'));
  assert.ok(xml.includes('<POSITION_MARK Name="Drop" Type="0" Start="150.250" Num="1"/>'));
  assert.ok(xml.includes('Name="Breakdown" Type="0" Start="120.000" Num="-1"'));
});

test("no cue claims a hot cue slot beyond the documented A/B/C", () => {
  const xml = build([makeTrack()]);
  for (const match of xml.matchAll(/Num="(-?\d+)"/g)) {
    const num = Number(match[1]);
    assert.ok(num === -1 || (num >= 0 && num <= 2), `Num=${num} is outside the safe range`);
  }
});

test("the beatgrid is omitted by default and emitted on request", () => {
  assert.ok(!build([makeTrack()]).includes("<TEMPO"), "a wrong grid is worse than none");

  const withGrid = build([makeTrack()], { includeBeatgrid: true });
  assert.ok(withGrid.includes('<TEMPO Inizio="0.482" Bpm="128.02" Metro="4/4" Battito="1"/>'));
});

test("BPM and key reach the fields Rekordbox reads", () => {
  const xml = build([makeTrack()]);
  assert.ok(xml.includes('AverageBpm="128.02"'));
  assert.ok(xml.includes('Tonality="Am"'), "Tonality takes classical notation, not Camelot");
});

test("an unanalyzed track still produces a valid entry, just without cues", () => {
  const xml = build([makeTrack({ analysis: null, durationSec: 180 })]);
  assert.ok(xml.includes("<TRACK "));
  assert.ok(!xml.includes("POSITION_MARK"));
  assert.ok(!xml.includes("AverageBpm"));
});

test("the playlist references tracks by TrackID and counts them", () => {
  const xml = build([makeTrack(), makeTrack({ trackId: 2 })]);
  assert.ok(xml.includes('<COLLECTION Entries="2">'));
  assert.ok(xml.includes('Name="My Set" Type="1" KeyType="0" Entries="2"'));
  assert.ok(xml.includes('<TRACK Key="1"/>'));
  assert.ok(xml.includes('<TRACK Key="2"/>'));
});

test("track ids are unique across the collection", () => {
  const xml = build([makeTrack(), makeTrack({ trackId: 2 }), makeTrack({ trackId: 3 })]);
  const ids = Array.from(xml.matchAll(/TrackID="(\d+)"/g), (m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "reusing a TrackID makes Rekordbox skip the import");
});

test("XML special characters in titles are escaped", () => {
  const xml = build([makeTrack({ title: 'Rock & Roll <"Live">' })]);
  assert.ok(xml.includes("&amp;"));
  assert.ok(!xml.includes('Name="Rock & Roll'));
});

test("the declared Entries counts match the elements actually written", () => {
  const xml = build([makeTrack(), makeTrack({ trackId: 2 }), makeTrack({ trackId: 3 })]);
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });

  const tracks = [].concat(DJ_PLAYLISTS.COLLECTION.TRACK);
  assert.equal(DJ_PLAYLISTS.COLLECTION["@Entries"], String(tracks.length));

  const playlist = [].concat(DJ_PLAYLISTS.PLAYLISTS.NODE.NODE)[0];
  const entries = [].concat(playlist.TRACK);
  assert.equal(playlist["@Entries"], String(entries.length));
});

test("every playlist entry resolves to a track in the collection", () => {
  const xml = build([makeTrack(), makeTrack({ trackId: 2 })]);
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });

  const ids = [].concat(DJ_PLAYLISTS.COLLECTION.TRACK).map((t) => t["@TrackID"]);
  const playlist = [].concat(DJ_PLAYLISTS.PLAYLISTS.NODE.NODE)[0];
  const keys = [].concat(playlist.TRACK).map((t) => t["@Key"]);

  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(ids.includes(key), `playlist references TrackID ${key}, which is not in the collection`);
  }
});

test("a second playlist can hold the same tracks in a different order", () => {
  const a = makeTrack({ trackId: 1 });
  const b = makeTrack({ trackId: 2 });
  const c = makeTrack({ trackId: 3 });

  const xml = build([a, b, c], {
    playlists: [{ name: "My Set (suggested order)", tracks: [c, a, b] }]
  });
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });

  const nodes = [].concat(DJ_PLAYLISTS.PLAYLISTS.NODE.NODE);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]["@Name"], "My Set");
  assert.equal(nodes[1]["@Name"], "My Set (suggested order)");

  assert.deepEqual([].concat(nodes[0].TRACK).map((t) => t["@Key"]), ["1", "2", "3"]);
  assert.deepEqual([].concat(nodes[1].TRACK).map((t) => t["@Key"]), ["3", "1", "2"]);

  // The point of referencing by TrackID: a reordering costs no duplicate metadata.
  assert.equal([].concat(DJ_PLAYLISTS.COLLECTION.TRACK).length, 3);
  assert.equal(DJ_PLAYLISTS.COLLECTION["@Entries"], "3");
});

test("the ROOT folder Count follows the number of playlists", () => {
  const tracks = [makeTrack()];

  const single = create(build(tracks)).end({ format: "object" });
  assert.equal(single.DJ_PLAYLISTS.PLAYLISTS.NODE["@Count"], "1");

  const double = create(
    build(tracks, { playlists: [{ name: "Suggested", tracks }] })
  ).end({ format: "object" });
  assert.equal(double.DJ_PLAYLISTS.PLAYLISTS.NODE["@Count"], "2");
});

test("every playlist declares the number of entries it actually holds", () => {
  const tracks = [makeTrack(), makeTrack({ trackId: 2 }), makeTrack({ trackId: 3 })];
  const xml = build(tracks, { playlists: [{ name: "Suggested", tracks: tracks.slice(0, 2) }] });
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });

  for (const node of [].concat(DJ_PLAYLISTS.PLAYLISTS.NODE.NODE)) {
    assert.equal(node["@Entries"], String([].concat(node.TRACK).length));
  }
});

test("a malformed extra playlist is skipped rather than written broken", () => {
  const tracks = [makeTrack()];
  const xml = build(tracks, {
    playlists: [{ name: "", tracks }, { name: "No tracks key" }, null]
  });
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });

  const nodes = [].concat(DJ_PLAYLISTS.PLAYLISTS.NODE.NODE);
  assert.equal(nodes.length, 1);
  assert.equal(DJ_PLAYLISTS.PLAYLISTS.NODE["@Count"], "1");
});

test("the classified style becomes the Genre Rekordbox browses by", () => {
  const xml = build([
    makeTrack({ genre: "Dance & EDM", style: { style: "melodic techno", source: "metadata" } })
  ]);
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });
  const track = [].concat(DJ_PLAYLISTS.COLLECTION.TRACK)[0];

  assert.equal(track["@Genre"], "Melodic Techno");
});

test("an inferred style is written unqualified, so genre filtering still groups", () => {
  const xml = build([makeTrack({ style: { style: "techno", source: "inferred" } })]);
  const { DJ_PLAYLISTS } = create(xml).end({ format: "object" });
  assert.equal([].concat(DJ_PLAYLISTS.COLLECTION.TRACK)[0]["@Genre"], "Techno");
});

test("the source genre survives when no style could be determined", () => {
  const xml = build([makeTrack({ genre: "Dance & EDM", style: { style: null, source: "unknown" } })]);
  // Asserted on the raw XML: the object reader does not decode entities, and the
  // escaping itself is worth pinning.
  assert.ok(xml.includes('Genre="Dance &amp; EDM"'), xml);
});

test("a Location decodes back to the exact path on disk", () => {
  const original = "/music/Odd  name #1 (100%) - a,b.mp3";
  const decoded = decodeURIComponent(
    toRekordboxLocation(original).replace("file://localhost", "")
  );
  assert.equal(decoded, path.resolve(original).normalize("NFC"));
});

test("the document declares the DJ_PLAYLISTS root Rekordbox looks for", () => {
  const xml = build([makeTrack()]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<DJ_PLAYLISTS Version="1.0.0">'));
  assert.ok(xml.includes("<PRODUCT "));
});
