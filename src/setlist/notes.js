/**
 * Render the suggested set as something a human can read at the decks.
 *
 * This is where the cue work from the analysis phase pays off. Advice like "blend
 * the next one in early" is useless in the moment; "start the blend at 5:12,
 * where the outgoing track's Mix out cue sits, and bring the next in at 1:04" is
 * something you can actually do, and both numbers are already measured and
 * already in the Rekordbox XML as hot cues.
 */

/** Cue names as the structure detector writes them. */
const CUE = {
  MIX_IN: "Mix in",
  MIX_OUT: "Mix out",
  DROP: "Drop",
  START: "Start"
};

/** @param {number} seconds */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** Fragments are composed from clauses, so they need capitalising and a stop. */
function sentence(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return "";
  const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** @param {object} track @param {string} name */
function findCue(track, name) {
  return (track?.analysis?.cues ?? []).find((cue) => cue.name === name) ?? null;
}

function describeBpm(bpm) {
  if (!bpm?.percent && bpm?.percent !== 0) return "tempo unknown";
  if (bpm.ratio === 2) return `double time (${bpm.percent.toFixed(1)}% off after doubling)`;
  if (bpm.ratio === 0.5) return `half time (${bpm.percent.toFixed(1)}% off after halving)`;
  if (bpm.percent <= 1) return "beatmatch straight";
  if (bpm.percent <= 6) return `nudge the pitch ${bpm.percent.toFixed(1)}%`;
  if (bpm.percent <= 12) return `${bpm.percent.toFixed(1)}% apart, at the edge of the pitch fader`;
  return `${bpm.percent.toFixed(1)}% apart, too far to beatmatch`;
}

/**
 * Choose a mixing technique from the measured relationship.
 *
 * The reasoning a DJ applies by instinct: a long blend exposes everything, so it
 * needs the key and tempo to agree. When they do not, the fix is to spend less
 * time with both tracks audible.
 *
 * @param {object} transition
 */
export function describeTechnique(transition) {
  const keyScore = transition.key?.score ?? 0.5;
  const bpmScore = transition.bpm?.score ?? 0.5;
  const energyDelta = transition.energy?.delta ?? 0;

  if (bpmScore < 0.3) {
    return "tempos are too far apart to blend; drop the next one in on a phrase break or use the outgoing track's outro as a gap";
  }
  if (keyScore <= 0.2) {
    return "the keys clash, so keep both tracks audible for as little as possible: a short cut over 8 to 16 beats";
  }
  if (keyScore >= 0.85 && bpmScore >= 0.9 && Math.abs(energyDelta) <= 1) {
    return "everything agrees here, so take your time: a long blend over 32 to 64 beats";
  }
  if (energyDelta >= 3) {
    return "a big lift, so make it feel deliberate: cut in on the drop rather than easing across";
  }
  if (energyDelta <= -3) {
    return "the energy drops, so let the outgoing track finish rather than fighting it: blend out over its outro";
  }
  return "a standard blend over 16 to 32 beats";
}

/**
 * Effect suggestions, each tied to something measured rather than offered as a
 * generic list of things a mixer can do.
 *
 * @param {object} transition
 * @returns {string[]}
 */
export function describeEffects(transition) {
  const effects = [];
  const keyScore = transition.key?.score ?? 0.5;
  const energyDelta = transition.energy?.delta ?? 0;
  const bpmScore = transition.bpm?.score ?? 0.5;

  if (keyScore <= 0.6) {
    effects.push("roll an echo off the outgoing track and cut it dead — the delay tail covers the key clash");
  }
  if (transition.key?.energyBoost) {
    effects.push("this is a deliberate lift in key, so let it land rather than filtering it away");
  }
  if (energyDelta >= 2) {
    effects.push("sweep a low-pass filter open on the incoming track across the last 8 bars");
  }
  if (energyDelta <= -2) {
    effects.push("a touch of reverb on the outgoing track's last phrase softens the landing");
  }
  if (bpmScore < 0.3) {
    effects.push("kill the outgoing bass a bar early so the two kicks never fight");
  }
  if (!effects.length) {
    effects.push("no effects needed; swap the basslines on the phrase boundary");
  }

  return effects;
}

/** @param {object} track */
function trackSummary(track) {
  const analysis = track?.analysis ?? null;
  const parts = [];

  parts.push(analysis?.bpm ? `${analysis.bpm.toFixed(1)} BPM` : "BPM n/a");
  parts.push(analysis?.camelot ? `${analysis.camelot} (${analysis.keyClassical})` : "key n/a");
  parts.push(analysis?.energyLevel ? `energy ${analysis.energyLevel}/10` : "energy n/a");

  if (track?.style?.style) {
    const label = track.style.source === "inferred" ? `${track.style.style}, inferred` : track.style.style;
    parts.push(label);
  }

  return parts.join(" · ");
}

/**
 * @param {{
 *   tracks: Array<object>,
 *   transitions: Array<object>,
 *   playlistName?: string,
 *   aiNotes?: Map<number, string> | null
 * }} input
 * @returns {string} markdown
 */
export function renderSetNotes({ tracks, transitions, playlistName = "Set", aiNotes = null }) {
  const lines = [];

  lines.push(`# Suggested set: ${playlistName}`, "");

  if (!tracks.length) {
    lines.push("No tracks were analysed, so there is nothing to suggest.", "");
    return lines.join("\n");
  }

  lines.push(...renderOverview(tracks), "");
  lines.push("## Running order", "");

  tracks.forEach((track, index) => {
    lines.push(`### ${index + 1}. ${track.title ?? "Untitled"}`, "");
    lines.push(trackSummary(track), "");

    const cueLine = renderCueLine(track);
    if (cueLine) lines.push(cueLine, "");

    const transition = transitions[index - 1];
    if (transition) {
      lines.push(...renderTransition(transition, tracks[index - 1], track, aiNotes?.get(index - 1)), "");
    }
  });

  lines.push(...renderFooter());
  return lines.join("\n");
}

function renderOverview(tracks) {
  const bpms = tracks.map((t) => t.analysis?.bpm).filter(Boolean);
  const totalSec = tracks.reduce((sum, t) => sum + (t.analysis?.durationSec ?? t.durationSec ?? 0), 0);

  const lines = [`${tracks.length} tracks, about ${Math.round(totalSec / 60)} minutes.`];
  if (bpms.length) {
    lines.push(
      "",
      `Tempo runs ${Math.min(...bpms).toFixed(0)} to ${Math.max(...bpms).toFixed(0)} BPM.`
    );
  }
  lines.push(
    "",
    "The order below warms up, peaks about three quarters of the way through, then eases off. Every time named is a cue point that is already in the Rekordbox XML, so you can find it on the CDJ rather than hunting for it."
  );
  return lines;
}

function renderCueLine(track) {
  const mixIn = findCue(track, CUE.MIX_IN) ?? findCue(track, CUE.START);
  const drop = findCue(track, CUE.DROP);
  const mixOut = findCue(track, CUE.MIX_OUT);

  const parts = [];
  if (mixIn) parts.push(`mix in ${formatClock(mixIn.startSec)}`);
  if (drop) parts.push(`drop ${formatClock(drop.startSec)}`);
  if (mixOut) parts.push(`mix out ${formatClock(mixOut.startSec)}`);

  if (!parts.length) return "Cues: none detected — mix this one by ear.";
  return `Cues: ${parts.join(", ")}.`;
}

function renderTransition(transition, fromTrack, toTrack, aiNote) {
  const lines = [];

  const keyMove = transition.key?.move ?? "unknown";
  lines.push(`**Coming from "${fromTrack?.title ?? "the previous track"}":** ${keyMove}, ${describeBpm(transition.bpm)}.`);

  const mixOut = findCue(fromTrack, CUE.MIX_OUT);
  const mixIn = findCue(toTrack, CUE.MIX_IN) ?? findCue(toTrack, CUE.START);

  // The wording has to follow the technique. Telling someone to "start the blend"
  // one line after telling them the two tracks cannot be blended is worse than
  // saying nothing.
  const blendable = (transition.bpm?.score ?? 0.5) >= 0.3;

  if (mixOut && mixIn) {
    lines.push(
      "",
      blendable
        ? `Start the blend at ${formatClock(mixOut.startSec)} (the outgoing track's Mix out) and bring this one in at ${formatClock(mixIn.startSec)} (its Mix in).`
        : `Let the outgoing track run to ${formatClock(mixOut.startSec)} (its Mix out), then start this one from ${formatClock(mixIn.startSec)} (its Mix in).`
    );
  } else if (mixIn) {
    lines.push("", `Bring this one in at ${formatClock(mixIn.startSec)} (its Mix in).`);
  }

  lines.push("", `${sentence(describeTechnique(transition))}`);

  lines.push("");
  for (const effect of describeEffects(transition)) {
    lines.push(`- ${effect}`);
  }

  if (aiNote) {
    lines.push("", `> ${aiNote}`);
  }

  return lines;
}

function renderFooter() {
  return [
    "---",
    "",
    "Tempo, key and energy are measured; the style is read from each track's own title and tags where it names one, and guessed from tempo where it does not. Key detection in particular is a hint rather than a verdict — trust your ears over this file.",
    ""
  ];
}
