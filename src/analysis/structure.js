import { median, runningMax } from "./energy.js";

/**
 * Turn energy envelopes into cue points a DJ can actually use.
 *
 * The whole approach leans on one property of electronic music: arrangements are
 * phrase-quantised. Sections start on 8, 16 or 32-bar boundaries essentially
 * without exception, so every candidate boundary found in the (noisy) energy
 * curve gets snapped to the grid. That single step is what makes crude detection
 * produce usable cues — a cue on the right downbeat with the wrong label is still
 * mixable, one that is 1.3 seconds early is not.
 */

/** Rekordbox POSITION_MARK Type values. */
export const CUE_TYPE = { CUE: 0, FADE_IN: 1, FADE_OUT: 2, LOAD: 3, LOOP: 4 };

/**
 * Only Num 0/1/2 (hot cues A/B/C) and -1 (memory cue) are documented by Pioneer.
 * A report of Num=3 failing to set hot cue D is the only empirical evidence
 * either way, so the three safe slots carry the cues a DJ reaches for live and
 * everything else becomes a memory cue, which has no count limit.
 */
export const MEMORY_CUE = -1;
export const HOT_CUE_A = 0;
export const HOT_CUE_B = 1;
export const HOT_CUE_C = 2;

const BEATS_PER_BAR = 4;
/** Mix-in and mix-out sit a phrase in from each end. */
const MIX_PHRASE_BARS = 32;
/** A breakdown must last at least this long to be worth a cue. */
const MIN_BREAKDOWN_BARS = 8;
/** Kick energy below this fraction of the track median reads as "kick is out". */
const KICK_DROPOUT_RATIO = 0.4;

/**
 * Find the first strong kick within the opening bars and call it beat 1.
 *
 * Essentia reports beat positions but not which of them starts a bar. For 4/4
 * material the loudest low-band onset near the start is a good proxy, and being
 * wrong here shifts the grid rather than breaking it.
 */
function findFirstDownbeat(bands, beats, secondsPerBar) {
  if (!beats.length) return null;

  const searchLimit = beats[0] + Math.max(secondsPerBar, 2);
  const candidates = beats.filter((t) => t <= searchLimit);
  if (!candidates.length) return beats[0];

  let best = candidates[0];
  let bestEnergy = -Infinity;
  for (const time of candidates) {
    const frame = Math.floor(time / 0.1);
    const energy = bands.low[frame] ?? 0;
    if (energy > bestEnergy) {
      bestEnergy = energy;
      best = time;
    }
  }
  return best;
}

/** Snap a time to the nearest multiple of `bars` from the first downbeat. */
function snapToPhrase(timeSec, firstDownbeatSec, secondsPerBar, bars) {
  const phrase = secondsPerBar * bars;
  if (phrase <= 0) return timeSec;
  const offset = timeSec - firstDownbeatSec;
  const snapped = Math.round(offset / phrase) * phrase;
  return Math.max(firstDownbeatSec, firstDownbeatSec + snapped);
}

/**
 * Contiguous frame ranges where the kick is absent but the rest of the mix is
 * not — the signature of a breakdown, as opposed to a genuine silence.
 *
 * `kickEnvelope` is the beat-windowed peak of the low band rather than its raw
 * per-frame RMS; see `runningMax`.
 */
function findBreakdowns(bands, kickEnvelope, frameSeconds, minFrames) {
  const kickMedian = median(kickEnvelope);
  const broadMedian = median(bands.broad);
  if (kickMedian <= 0 || broadMedian <= 0) return [];

  const kickFloor = kickMedian * KICK_DROPOUT_RATIO;
  const aliveFloor = broadMedian * 0.15;

  const ranges = [];
  let start = -1;

  for (let i = 0; i < kickEnvelope.length; i += 1) {
    const kickOut = kickEnvelope[i] < kickFloor;
    const stillPlaying = bands.broad[i] > aliveFloor;

    if (kickOut && stillPlaying) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      if (i - start >= minFrames) ranges.push({ startFrame: start, endFrame: i });
      start = -1;
    }
  }
  if (start !== -1 && kickEnvelope.length - start >= minFrames) {
    ranges.push({ startFrame: start, endFrame: kickEnvelope.length });
  }

  return ranges.map((r) => ({
    startSec: r.startFrame * frameSeconds,
    endSec: r.endFrame * frameSeconds
  }));
}

/** First frame where the kick is properly present, i.e. the track has started. */
function findFirstKick(kickEnvelope, frameSeconds) {
  const kickMedian = median(kickEnvelope);
  if (kickMedian <= 0) return 0;
  const threshold = kickMedian * 0.5;
  for (let i = 0; i < kickEnvelope.length; i += 1) {
    if (kickEnvelope[i] >= threshold) return i * frameSeconds;
  }
  return 0;
}

/** Last frame where the mix is still going, so a fade-out does not become the outro. */
function findLastActive(bands, frameSeconds) {
  const broadMedian = median(bands.broad);
  const threshold = broadMedian * 0.2;
  for (let i = bands.broad.length - 1; i >= 0; i -= 1) {
    if (bands.broad[i] >= threshold) return (i + 1) * frameSeconds;
  }
  return bands.broad.length * frameSeconds;
}

/**
 * @param {{ bands: object, beats: number[], bpm: number | null, durationSec: number }} input
 * @returns {{ firstDownbeatSec: number | null, cues: object[], sections: object[] }}
 */
export function detectStructure({ bands, beats = [], bpm, durationSec }) {
  const frameSeconds = bands?.frameSeconds ?? 0.1;
  const cues = [];
  const sections = [];

  // Without a tempo there is no phrase grid, so cues would be unsnapped guesses.
  // A single load-position cue at the first kick is still genuinely useful.
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) {
    const fallbackEnvelope = runningMax(bands.low, Math.round(0.5 / frameSeconds));
    const firstKick = findFirstKick(fallbackEnvelope, frameSeconds);
    cues.push({
      name: "Start",
      type: CUE_TYPE.CUE,
      num: MEMORY_CUE,
      startSec: round3(firstKick)
    });
    return { firstDownbeatSec: null, cues, sections };
  }

  const secondsPerBeat = 60 / bpm;
  const secondsPerBar = secondsPerBeat * BEATS_PER_BAR;
  const kickEnvelope = runningMax(bands.low, secondsPerBeat / frameSeconds);

  const firstDownbeatSec =
    findFirstDownbeat(bands, beats, secondsPerBar) ?? findFirstKick(kickEnvelope, frameSeconds);

  const trackStart = findFirstKick(kickEnvelope, frameSeconds);
  const trackEnd = Math.min(findLastActive(bands, frameSeconds), durationSec);

  const introStart = snapToPhrase(trackStart, firstDownbeatSec, secondsPerBar, 1);
  const mixIn = introStart + secondsPerBar * MIX_PHRASE_BARS;
  const mixOut = trackEnd - secondsPerBar * MIX_PHRASE_BARS;

  const minBreakdownFrames = Math.round((secondsPerBar * MIN_BREAKDOWN_BARS) / frameSeconds);
  const breakdowns = findBreakdowns(bands, kickEnvelope, frameSeconds, minBreakdownFrames)
    // A breakdown in the first phrase is just the intro; one at the very end is the outro.
    .filter((b) => b.startSec > introStart + secondsPerBar * 8 && b.endSec < trackEnd - secondsPerBar * 4);

  // The drop is the kick returning after the longest breakdown — the moment the
  // track is built around, and the one cue worth a dedicated hot cue.
  const mainBreakdown = breakdowns.slice().sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))[0];

  // On anything shorter than a couple of phrases the 32-bar mix-in lands at or
  // past the end, where it is worse than useless. The intro memory cue below
  // still gives such a track a sensible load point.
  const hasRoomToMix = mixIn < trackEnd - secondsPerBar * 4;

  if (hasRoomToMix) {
    cues.push({
      name: "Mix in",
      type: CUE_TYPE.CUE,
      num: HOT_CUE_A,
      startSec: round3(clampTime(mixIn, 0, durationSec))
    });
  }

  if (mainBreakdown) {
    const dropSec = snapToPhrase(mainBreakdown.endSec, firstDownbeatSec, secondsPerBar, 8);
    cues.push({
      name: "Drop",
      type: CUE_TYPE.CUE,
      num: HOT_CUE_B,
      startSec: round3(clampTime(dropSec, 0, durationSec))
    });
    sections.push({ label: "breakdown", startSec: round3(mainBreakdown.startSec), endSec: round3(mainBreakdown.endSec) });
  }

  if (hasRoomToMix && mixOut > mixIn) {
    cues.push({
      name: "Mix out",
      type: CUE_TYPE.CUE,
      num: HOT_CUE_C,
      startSec: round3(clampTime(snapToPhrase(mixOut, firstDownbeatSec, secondsPerBar, 4), 0, durationSec))
    });
  }

  // Memory cues: unlimited, and what CDJs step through with the cue button.
  cues.push({
    name: "Intro",
    type: CUE_TYPE.CUE,
    num: MEMORY_CUE,
    startSec: round3(clampTime(introStart, 0, durationSec))
  });

  for (const breakdown of breakdowns) {
    const snapped = snapToPhrase(breakdown.startSec, firstDownbeatSec, secondsPerBar, 8);
    cues.push({
      name: "Breakdown",
      type: CUE_TYPE.CUE,
      num: MEMORY_CUE,
      startSec: round3(clampTime(snapped, 0, durationSec))
    });
  }

  const outroStart = snapToPhrase(trackEnd - secondsPerBar * 16, firstDownbeatSec, secondsPerBar, 8);
  if (hasRoomToMix && outroStart > mixIn) {
    cues.push({
      name: "Outro",
      type: CUE_TYPE.CUE,
      num: MEMORY_CUE,
      startSec: round3(clampTime(outroStart, 0, durationSec))
    });
  }

  sections.push({ label: "intro", startSec: round3(introStart), endSec: round3(Math.min(mixIn, trackEnd)) });
  sections.push({
    label: "outro",
    startSec: round3(clampTime(outroStart, introStart, trackEnd)),
    endSec: round3(trackEnd)
  });

  return {
    firstDownbeatSec: round3(firstDownbeatSec),
    cues: dedupeCues(cues),
    sections: sections.sort((a, b) => a.startSec - b.startSec)
  };
}

/**
 * Two cues on the same downbeat is a Rekordbox annoyance, and after phrase
 * snapping it happens often on short tracks. Hot cues win over memory cues.
 */
function dedupeCues(cues) {
  const byTime = new Map();
  for (const cue of cues) {
    const bucket = cue.startSec.toFixed(2);
    const existing = byTime.get(bucket);
    if (!existing || (existing.num === MEMORY_CUE && cue.num !== MEMORY_CUE)) {
      byTime.set(bucket, cue);
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.startSec - b.startSec);
}

function clampTime(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
