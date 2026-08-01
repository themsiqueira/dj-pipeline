/**
 * DJ style classification from metadata, with measured features as a fallback.
 *
 * There is no model for this. Essentia.js ships only MusiCNN and VGGish wrappers,
 * and the one electronic-genre model that fits has five classes (ambient, dnb,
 * house, techno, trance) trained on 250 examples. Melodic techno, tech house and
 * hard techno — the words DJs actually use — appear in no available taxonomy.
 *
 * What does work is that uploads usually say it outright: a video titled
 * "MELODIC TECHNO MIX" or tagged `tech house` has already answered the question.
 *
 * The two sources are deliberately kept apart. Metadata may assert a specific
 * style; measured features may only infer a broad family. BPM cannot separate
 * tech house from melodic techno — both sit at 125-128 — so pretending otherwise
 * would produce confident nonsense.
 */

/**
 * How much to trust each metadata field, calibrated against what yt-dlp actually
 * returns. `genre` is an explicit declaration but is only ever populated for
 * SoundCloud. Titles are reliable. Tags drift off-topic (a drum-loop upload tags
 * itself "drum play along", not "techno"). Descriptions are mostly links.
 *
 * `categories` is excluded outright: YouTube returns generic buckets like "Music"
 * or "People & Blogs", which never name a style.
 */
const FIELD_WEIGHT = {
  genre: 1,
  title: 0.9,
  tags: 0.6,
  description: 0.4,
  uploader: 0.3
};

/**
 * Style vocabulary. Each entry is a canonical name plus the spellings seen in the
 * wild. Matching runs longest-alias-first, which is the whole trick: "tech house"
 * has to be tested before "house", and "melodic techno" before "techno", or every
 * subgenre collapses into its parent.
 */
const STYLES = [
  { name: "melodic techno", aliases: ["melodic techno", "melodic house & techno", "melodic house and techno"] },
  { name: "peak time techno", aliases: ["peak time techno", "peak-time techno", "driving techno"] },
  { name: "hard techno", aliases: ["hard techno", "hardtechno", "schranz"] },
  { name: "hardgroove", aliases: ["hardgroove", "hard groove"] },
  { name: "industrial techno", aliases: ["industrial techno"] },
  { name: "acid techno", aliases: ["acid techno", "acid house"] },
  { name: "dub techno", aliases: ["dub techno", "dubtechno"] },
  { name: "minimal techno", aliases: ["minimal techno", "minimal / deep tech", "minimal deep tech"] },
  { name: "detroit techno", aliases: ["detroit techno"] },
  { name: "tech house", aliases: ["tech house", "techhouse", "tech-house"] },
  { name: "deep house", aliases: ["deep house", "deephouse"] },
  { name: "progressive house", aliases: ["progressive house", "prog house"] },
  { name: "melodic house", aliases: ["melodic house"] },
  { name: "afro house", aliases: ["afro house", "afrohouse", "3 step", "afro tech"] },
  { name: "organic house", aliases: ["organic house", "organic house / downtempo"] },
  { name: "bass house", aliases: ["bass house"] },
  { name: "future house", aliases: ["future house"] },
  { name: "disco house", aliases: ["disco house", "french house", "filter house"] },
  { name: "nu disco", aliases: ["nu disco", "nu-disco", "disco"] },
  { name: "psytrance", aliases: ["psytrance", "psy trance", "psychedelic trance", "goa trance"] },
  { name: "progressive trance", aliases: ["progressive trance"] },
  { name: "uplifting trance", aliases: ["uplifting trance"] },
  { name: "hard trance", aliases: ["hard trance"] },
  { name: "liquid dnb", aliases: ["liquid dnb", "liquid drum and bass", "liquid drum & bass", "liquid funk"] },
  { name: "neurofunk", aliases: ["neurofunk", "neuro dnb"] },
  { name: "jungle", aliases: ["jungle"] },
  { name: "drum and bass", aliases: ["drum and bass", "drum & bass", "drum n bass", "drumandbass", "dnb", "d&b"] },
  { name: "dubstep", aliases: ["dubstep", "riddim", "brostep"] },
  { name: "hardstyle", aliases: ["hardstyle", "rawstyle", "raw hardstyle"] },
  { name: "uptempo", aliases: ["uptempo hardcore", "uptempo"] },
  { name: "gabber", aliases: ["gabber", "gabba"] },
  { name: "hardcore", aliases: ["hardcore", "frenchcore", "terrorcore"] },
  { name: "uk garage", aliases: ["uk garage", "ukg", "2 step", "2-step", "speed garage"] },
  { name: "breakbeat", aliases: ["breakbeat", "breakbeats", "big beat", "nu skool breaks"] },
  { name: "electro", aliases: ["electro house", "electro"] },
  { name: "big room", aliases: ["big room"] },
  { name: "future bass", aliases: ["future bass"] },
  { name: "trap", aliases: ["trap"] },
  { name: "ambient", aliases: ["ambient"] },
  { name: "downtempo", aliases: ["downtempo", "chillout", "chill out", "lofi", "lo-fi", "trip hop"] },
  { name: "techno", aliases: ["techno"] },
  { name: "house", aliases: ["house"] },
  { name: "trance", aliases: ["trance"] },
  { name: "breaks", aliases: ["breaks"] },
  { name: "garage", aliases: ["garage"] }
];

/**
 * Every alias paired with its canonical style, longest first. Aliases go through
 * the same normaliser as the text they are matched against, so "d&b" becomes
 * "d & b" on both sides and lines up.
 */
const ALIAS_INDEX = STYLES.flatMap((style) =>
  style.aliases.map((alias) => ({ alias: normalize(alias), name: style.name }))
).sort((a, b) => b.alias.length - a.alias.length);

/**
 * Broad families that BPM and energy can genuinely distinguish. Deliberately
 * excludes the subgenres that share a tempo range — inferring "melodic techno"
 * from 126 BPM would be a guess dressed as a measurement.
 */
const TEMPO_FAMILIES = [
  { max: 90, name: "downtempo" },
  { max: 112, name: "breaks" },
  { max: 122, name: "house" },
  { max: 130, name: null }, // decided by energy below
  { max: 142, name: "techno" },
  { max: 155, name: "hard techno" },
  { max: 165, name: "hardstyle" },
  { max: 185, name: "drum and bass" },
  { max: Infinity, name: "hardcore" }
];

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    // Separators become spaces so "House/Techno" and "melodic-techno" both match.
    .replace(/[_\-/|,()[\]{}"'’]+/g, " ")
    .replace(/&/g, " & ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Position of `phrase` in `haystack` on word boundaries, or -1. Boundaries stop
 * "house" firing inside "housekeeping" and "techno" inside "technology".
 */
function phraseIndex(haystack, phrase) {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(phrase, from);
    if (index === -1) return -1;

    const before = index === 0 ? " " : haystack[index - 1];
    const afterIndex = index + phrase.length;
    const after = afterIndex >= haystack.length ? " " : haystack[afterIndex];

    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return index;
    from = index + 1;
  }
}

/**
 * @param {object} meta
 * @returns {{ name: string, field: string, weight: number, alias: string } | null}
 */
function matchFromMetadata(meta) {
  const fields = [
    ["genre", normalize(meta.genre)],
    ["title", normalize(meta.title)],
    ["tags", normalize(Array.isArray(meta.tags) ? meta.tags.join(" ") : meta.tags)],
    ["description", normalize(meta.description)],
    ["uploader", normalize(meta.uploader)]
  ];

  let best = null;

  for (const [field, haystack] of fields) {
    if (!haystack) continue;

    const hit = bestAliasIn(haystack);
    if (!hit) continue;

    const weight = FIELD_WEIGHT[field] ?? 0;
    if (!best || weight > best.weight) {
      best = { name: hit.name, field, weight, alias: hit.alias };
    }
  }

  return best;
}

/**
 * The best style alias occurring in one piece of text.
 *
 * Earliest position wins, then longest alias. Position rather than length is what
 * keeps siblings honest: "House / techno" leads with house, and calling it techno
 * because that word happens to be one letter longer would be arbitrary. Subgenres
 * still beat their parents for free, since "melodic techno" starts at or before
 * the "techno" inside it.
 */
function bestAliasIn(haystack) {
  let best = null;

  for (const { alias, name } of ALIAS_INDEX) {
    const index = phraseIndex(haystack, alias);
    if (index === -1) continue;

    if (!best || index < best.index || (index === best.index && alias.length > best.alias.length)) {
      best = { name, alias, index };
    }
  }

  return best;
}

/**
 * @param {{ bpm: number | null, energyLevel: number | null }} features
 * @returns {string | null}
 */
function familyFromFeatures({ bpm, energyLevel }) {
  if (!bpm || !Number.isFinite(bpm)) return null;

  for (const band of TEMPO_FAMILIES) {
    if (bpm > band.max) continue;
    if (band.name) return band.name;
    // 122-130 is where house and techno overlap; drive is what separates them.
    return (energyLevel ?? 0) >= 8 ? "techno" : "house";
  }
  return null;
}

/**
 * Classify one track.
 *
 * @param {object} input metadata fields plus the analysis result
 * @returns {{ style: string | null, source: "metadata" | "inferred" | "unknown",
 *            confidence: number, evidence: string | null }}
 */
export function detectStyle(input = {}) {
  const fromMetadata = matchFromMetadata(input);
  if (fromMetadata) {
    return {
      style: fromMetadata.name,
      source: "metadata",
      confidence: fromMetadata.weight,
      evidence: fromMetadata.field
    };
  }

  const family = familyFromFeatures({
    bpm: input.bpm ?? null,
    energyLevel: input.energyLevel ?? null
  });

  if (family) {
    return { style: family, source: "inferred", confidence: 0.35, evidence: "bpm+energy" };
  }

  return { style: null, source: "unknown", confidence: 0, evidence: null };
}

/**
 * How well two styles sit together in a set. Used by the set builder, where a
 * hard techno track dropped into a melodic warm-up is the failure to avoid.
 *
 * @returns {number} 0 to 1
 */
export function styleAffinity(a, b) {
  if (!a || !b) return 0.6;
  if (a === b) return 1;

  const groupA = STYLE_GROUP[a];
  const groupB = STYLE_GROUP[b];
  if (!groupA || !groupB) return 0.6;
  if (groupA === groupB) return 0.85;

  const pair = [groupA, groupB].sort().join("|");
  return ADJACENT_GROUPS.has(pair) ? 0.6 : 0.25;
}

/** Families that share a dancefloor. */
const STYLE_GROUP = {
  "melodic techno": "melodic",
  "melodic house": "melodic",
  "progressive house": "melodic",
  "organic house": "melodic",
  "deep house": "housey",
  "tech house": "housey",
  "house": "housey",
  "afro house": "housey",
  "disco house": "housey",
  "nu disco": "housey",
  "bass house": "housey",
  "future house": "housey",
  "electro": "housey",
  "minimal techno": "techno",
  "dub techno": "techno",
  "detroit techno": "techno",
  "techno": "techno",
  "peak time techno": "techno",
  "acid techno": "techno",
  "industrial techno": "hard",
  "hard techno": "hard",
  "hardgroove": "hard",
  "hardstyle": "hard",
  "gabber": "hard",
  "hardcore": "hard",
  "uptempo": "hard",
  "trance": "trance",
  "psytrance": "trance",
  "progressive trance": "trance",
  "uplifting trance": "trance",
  "hard trance": "trance",
  "drum and bass": "bass",
  "liquid dnb": "bass",
  "neurofunk": "bass",
  "jungle": "bass",
  "dubstep": "bass",
  "breakbeat": "bass",
  "breaks": "bass",
  "uk garage": "bass",
  "garage": "bass",
  "trap": "bass",
  "future bass": "bass",
  "big room": "big",
  "ambient": "chill",
  "downtempo": "chill"
};

/** Group pairs that mix without jarring, in either direction. */
const ADJACENT_GROUPS = new Set([
  ["melodic", "techno"].sort().join("|"),
  ["melodic", "housey"].sort().join("|"),
  ["melodic", "trance"].sort().join("|"),
  ["housey", "techno"].sort().join("|"),
  ["techno", "hard"].sort().join("|"),
  ["techno", "trance"].sort().join("|"),
  ["chill", "melodic"].sort().join("|"),
  ["bass", "housey"].sort().join("|"),
  ["big", "housey"].sort().join("|"),
  ["big", "trance"].sort().join("|")
]);

/** The canonical style names, for tests and documentation. */
export function knownStyles() {
  return STYLES.map((s) => s.name);
}
