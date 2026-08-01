import path from "path";
import { create } from "xmlbuilder2";
import { ensureDir } from "./util.js";

/**
 * Rekordbox's own XML format (DJ_PLAYLISTS), as documented in Pioneer's
 * `xml_format_list.pdf`.
 *
 * This replaces the iTunes plist the project used to emit. The iTunes schema has
 * no fields for cue points or beatgrids at all, so it can only ever hand
 * Rekordbox a file path and let it analyse from scratch. DJ_PLAYLISTS carries
 * `TEMPO` and `POSITION_MARK`, which is the entire point of the analysis phase.
 */

const KIND_BY_EXTENSION = {
  ".mp3": "MP3 File",
  ".flac": "FLAC File",
  ".wav": "WAV File",
  ".aiff": "AIFF File",
  ".aif": "AIFF File",
  ".m4a": "M4A File",
  ".aac": "M4A File"
};

/**
 * Rekordbox writes `file://localhost/` rather than the three-slash `file:///`
 * that `URL.pathToFileURL` produces, and matches paths byte-wise in places, so
 * the string is NFC-normalised first — macOS stores filenames decomposed, and a
 * track with an accent would otherwise not be found.
 *
 * @param {string} filePath absolute path
 */
export function toRekordboxLocation(filePath) {
  const absolute = path.resolve(filePath).normalize("NFC");

  // Windows: D:\Music\x.mp3 -> /D:/Music/x.mp3, with the drive colon left alone.
  const posix = absolute.replace(/\\/g, "/");
  const withLeadingSlash = posix.startsWith("/") ? posix : `/${posix}`;

  const encoded = withLeadingSlash
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment)
        // Both are legal unencoded in a path segment, and Rekordbox's own
        // exports leave them that way. `:` additionally has to survive so a
        // Windows drive letter still reads as `/D:/...`.
        .replace(/%3A/gi, ":")
        .replace(/%2C/gi, ",")
    )
    .join("/");

  return `file://localhost${encoded}`;
}

/** Rekordbox stores star ratings as 0/51/102/153/204/255, not 0-5. */
export function toRekordboxRating(stars) {
  const clamped = Math.min(5, Math.max(0, Math.round(Number(stars) || 0)));
  return clamped * 51;
}

function formatSeconds(value) {
  return String(Math.round(Number(value) || 0));
}

function formatFloat(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toFixed(digits);
}

/**
 * The classified style as a genre label, title-cased for the Rekordbox browser.
 *
 * Inferred styles are written unqualified here on purpose. Rekordbox treats Genre
 * as a filter facet, so marking a guess inline would split one style into two
 * browser entries and make sorting worse. The inferred/asserted distinction is
 * reported in the run log and the set notes instead, where prose fits.
 *
 * @param {{ style?: string | null } | null | undefined} style
 */
function styleLabel(style) {
  if (!style?.style) return "";
  return style.style.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * @param {{
 *   tracks: Array<object>,
 *   playlistName: string,
 *   outputXmlPath: string,
 *   includeBeatgrid?: boolean,
 *   playlists?: Array<{ name: string, tracks: Array<object> }>
 * }} input
 * @returns {string} the serialised XML
 */
export function buildRekordboxXml({
  tracks,
  playlistName,
  outputXmlPath,
  includeBeatgrid = false,
  playlists: extraPlaylists = []
}) {
  ensureDir(path.dirname(outputXmlPath));

  // The collection holds each track once; a playlist is only a list of TrackIDs
  // pointing back into it, so an alternative running order costs one extra node
  // per track rather than a second copy of the file's metadata.
  const playlistDefs = [{ name: playlistName, tracks }, ...extraPlaylists].filter(
    (definition) => definition?.name && Array.isArray(definition.tracks)
  );

  const root = create({ version: "1.0", encoding: "UTF-8" }).ele("DJ_PLAYLISTS", {
    Version: "1.0.0"
  });

  root.ele("PRODUCT", {
    Name: "DJ Pipeline",
    Version: "1.0",
    Company: "youtube-dj-pipeline"
  });

  const collection = root.ele("COLLECTION", { Entries: String(tracks.length) });

  for (const track of tracks) {
    const analysis = track.analysis ?? null;
    const durationSec = analysis?.durationSec ?? track.durationSec ?? 0;

    /** @type {Record<string, string>} */
    const attributes = {
      TrackID: String(track.trackId),
      Name: track.title ?? "",
      Artist: track.artist ?? "",
      Album: track.album ?? "",
      Kind: KIND_BY_EXTENSION[path.extname(track.filePath ?? "").toLowerCase()] ?? "MP3 File",
      TotalTime: formatSeconds(durationSec),
      Location: toRekordboxLocation(track.filePath ?? "")
    };

    if (track.trackNumber) attributes.TrackNumber = String(track.trackNumber);
    if (track.year) attributes.Year = String(track.year);
    // The classified DJ style is more use in a Rekordbox browser than the source's
    // own genre, which on YouTube is usually absent and on SoundCloud is often a
    // bucket as broad as "Dance & EDM".
    const genre = styleLabel(track.style) || track.genre;
    if (genre) attributes.Genre = genre;
    if (track.sizeBytes) attributes.Size = String(track.sizeBytes);
    if (track.comment) attributes.Comments = track.comment;

    if (analysis) {
      if (analysis.bpm) attributes.AverageBpm = formatFloat(analysis.bpm, 2);
      if (analysis.keyClassical) attributes.Tonality = analysis.keyClassical;
      if (analysis.sampleRate) attributes.SampleRate = String(analysis.sampleRate);
    }

    const trackNode = collection.ele("TRACK", attributes);

    // A single TEMPO marker describes a whole constant-tempo grid. Off by default:
    // Rekordbox's own grid detection is strong on 4/4 material, and a beatgrid
    // that is one beat out is worse than none at all.
    if (includeBeatgrid && analysis?.bpm && analysis.firstDownbeatSec !== null && analysis.firstDownbeatSec !== undefined) {
      trackNode.ele("TEMPO", {
        Inizio: formatFloat(analysis.firstDownbeatSec),
        Bpm: formatFloat(analysis.bpm, 2),
        Metro: "4/4",
        Battito: "1"
      });
    }

    for (const cue of analysis?.cues ?? []) {
      /** @type {Record<string, string>} */
      const cueAttributes = {
        Name: cue.name ?? "",
        Type: String(cue.type ?? 0),
        Start: formatFloat(cue.startSec),
        Num: String(cue.num ?? -1)
      };
      if (cue.endSec !== undefined && cue.endSec !== null) {
        cueAttributes.End = formatFloat(cue.endSec);
      }
      trackNode.ele("POSITION_MARK", cueAttributes);
    }
  }

  const playlists = root.ele("PLAYLISTS");
  // Type 0 is a folder, type 1 a playlist; ROOT must be a folder. Count is the
  // number of children, so it has to follow however many playlists were asked for.
  const rootNode = playlists.ele("NODE", {
    Type: "0",
    Name: "ROOT",
    Count: String(playlistDefs.length)
  });

  for (const definition of playlistDefs) {
    const playlistNode = rootNode.ele("NODE", {
      Name: definition.name,
      Type: "1",
      // KeyType 0 means the entries below reference TrackID rather than Location.
      KeyType: "0",
      Entries: String(definition.tracks.length)
    });

    for (const track of definition.tracks) {
      playlistNode.ele("TRACK", { Key: String(track.trackId) });
    }
  }

  return root.end({ prettyPrint: true });
}
