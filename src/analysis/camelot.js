/**
 * Camelot wheel conversion and harmonic-mixing rules.
 *
 * The wheel numbers keys 1-12 like clock hours; adjacent numbers are a perfect
 * fifth apart, and the A/B letters at a given number are relative minor/major.
 * That geometry is what makes "compatible" a matter of simple arithmetic:
 * neighbouring keys share six of their seven scale tones.
 *
 * Pure functions only — no audio, no IO. The set-ordering feature builds on this.
 */

/** Camelot code -> canonical classical notation, as Rekordbox writes it. */
const CAMELOT_TO_CLASSICAL = {
  "1A": "Abm",
  "1B": "B",
  "2A": "Ebm",
  "2B": "F#",
  "3A": "Bbm",
  "3B": "Db",
  "4A": "Fm",
  "4B": "Ab",
  "5A": "Cm",
  "5B": "Eb",
  "6A": "Gm",
  "6B": "Bb",
  "7A": "Dm",
  "7B": "F",
  "8A": "Am",
  "8B": "C",
  "9A": "Em",
  "9B": "G",
  "10A": "Bm",
  "10B": "D",
  "11A": "F#m",
  "11B": "A",
  "12A": "C#m",
  "12B": "E"
};

/** Pitch classes, indexed to match Essentia's `key` output. */
const PITCH_CLASS = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  F: 5,
  "E#": 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  Cb: 11
};

/**
 * Camelot number for each pitch class, per mode. Derived from the circle of
 * fifths rather than computed at runtime so the mapping is auditable.
 */
const MAJOR_PITCH_TO_CAMELOT = { 0: 8, 1: 3, 2: 10, 3: 5, 4: 12, 5: 7, 6: 2, 7: 9, 8: 4, 9: 11, 10: 6, 11: 1 };
const MINOR_PITCH_TO_CAMELOT = { 0: 5, 1: 12, 2: 7, 3: 2, 4: 9, 5: 4, 6: 11, 7: 6, 8: 1, 9: 8, 10: 3, 11: 10 };

/**
 * @param {string} key   pitch class, e.g. "C" or "F#"
 * @param {string} scale "major" or "minor"
 * @returns {string | null} Camelot code such as "8A", or null when unparseable
 */
export function toCamelot(key, scale) {
  if (!key || !scale) return null;
  const pitch = PITCH_CLASS[String(key).trim()];
  if (pitch === undefined) return null;

  const isMinor = String(scale).trim().toLowerCase().startsWith("min");
  const number = isMinor ? MINOR_PITCH_TO_CAMELOT[pitch] : MAJOR_PITCH_TO_CAMELOT[pitch];
  if (!number) return null;

  return `${number}${isMinor ? "A" : "B"}`;
}

/**
 * Rekordbox's `Tonality` field. Sources disagree on whether it wants classical
 * (`Am`) or Camelot (`8A`); classical is what Rekordbox's own exports use, and it
 * renders as Camelot anyway when the user sets Preferences > View > Key display
 * format to alphanumeric.
 *
 * @param {string | null} camelot
 * @returns {string} empty string when unknown, so callers can omit the attribute
 */
export function camelotToClassical(camelot) {
  if (!camelot) return "";
  return CAMELOT_TO_CLASSICAL[String(camelot).trim().toUpperCase()] ?? "";
}

/** @returns {{ number: number, letter: "A" | "B" } | null} */
export function parseCamelot(camelot) {
  const match = /^(\d{1,2})([AB])$/.exec(String(camelot ?? "").trim().toUpperCase());
  if (!match) return null;
  const number = Number(match[1]);
  if (number < 1 || number > 12) return null;
  return { number, letter: /** @type {"A" | "B"} */ (match[2]) };
}

/** Wheel arithmetic wraps at 12 -> 1. */
function wrap(number) {
  return ((number - 1 + 12) % 12) + 1;
}

/**
 * The moves a DJ can make without the two tracks clashing: same key, a perfect
 * fifth either way, the relative major/minor, and the two diagonals.
 *
 * @param {string} camelot
 * @returns {string[]} compatible Camelot codes, excluding the input
 */
export function compatibleKeys(camelot) {
  const parsed = parseCamelot(camelot);
  if (!parsed) return [];
  const { number, letter } = parsed;
  const other = letter === "A" ? "B" : "A";

  return [
    `${wrap(number + 1)}${letter}`,
    `${wrap(number - 1)}${letter}`,
    `${number}${other}`,
    `${wrap(number + 1)}${other}`,
    `${wrap(number - 1)}${other}`
  ];
}

/**
 * How well two keys mix, 0 to 1. Used to rank candidate transitions.
 *
 * Unknown keys score 0.5 rather than 0: a track we failed to analyse should not
 * be pushed to the end of every set.
 *
 * @returns {{ score: number, move: string, energyBoost: boolean }}
 */
export function keyCompatibility(fromCamelot, toCamelot_) {
  const a = parseCamelot(fromCamelot);
  const b = parseCamelot(toCamelot_);
  if (!a || !b) return { score: 0.5, move: "unknown", energyBoost: false };

  const delta = ((b.number - a.number + 12) % 12);
  const sameLetter = a.letter === b.letter;

  if (sameLetter && delta === 0) return { score: 1, move: "same key", energyBoost: false };
  if (sameLetter && delta === 1) return { score: 0.95, move: "+1 (fifth up)", energyBoost: false };
  if (sameLetter && delta === 11) return { score: 0.95, move: "-1 (fifth down)", energyBoost: false };
  if (!sameLetter && delta === 0) return { score: 0.9, move: "relative major/minor", energyBoost: false };
  if (!sameLetter && (delta === 1 || delta === 11)) {
    return { score: 0.85, move: "diagonal", energyBoost: false };
  }
  // Deliberately dissonant moves. They work, but only over a short percussive
  // cut — a long blend exposes the clash.
  if (sameLetter && delta === 2) return { score: 0.6, move: "+2 (energy boost)", energyBoost: true };
  if (sameLetter && delta === 7) return { score: 0.5, move: "+7 (semitone jump)", energyBoost: true };

  return { score: 0.1, move: "clash", energyBoost: false };
}
