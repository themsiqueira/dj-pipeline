import os from "os";
import { mapWithConcurrency } from "../concurrency.js";
import { analyzeTrack } from "./analyzeTrack.js";
import { detectStyle } from "./genre.js";
import { getEssentia, getEssentiaLoadError } from "./essentia.js";
import { recordDiagnostic } from "../diagnostics.js";

/**
 * Analysis is CPU-bound, unlike the download phase which is network-bound and
 * deliberately throttled to avoid YouTube's bot detection. Sizing this from the
 * core count rather than reusing the download limit is what keeps a large
 * playlist from taking hours.
 *
 * Capped at 4 because each worker holds a decoded track in memory — roughly
 * 105 MB for ten minutes of audio.
 */
export function resolveAnalysisConcurrency() {
  const override = Number(process.env.YOUTUBE_DJ_ANALYSIS_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  return Math.max(1, Math.min(4, Math.ceil((os.cpus()?.length || 2) / 2)));
}

/** True when the analysis engine actually loaded; lets callers explain a skip. */
export function isAnalysisAvailable() {
  return getEssentia() !== null;
}

export function getAnalysisUnavailableReason() {
  const err = getEssentiaLoadError();
  return err ? err.message : null;
}

/**
 * Measure every downloaded track and attach the result in place.
 *
 * Failure is always local: a track that cannot be analysed keeps its metadata and
 * simply carries no cues into the XML. Losing the whole run's artifacts because
 * one file was malformed would be a bad trade.
 *
 * @param {Array<{ filePath?: string, title?: string }>} tracks
 * @param {{ signal?: AbortSignal, onLog?: (line: string) => void,
 *           onProgress?: (p: { current: number, total: number, title: string }) => void }} [options]
 * @returns {Promise<{ analyzed: number, failed: number }>}
 */
export async function analyzeTracks(tracks, options = {}) {
  const { signal, onLog = () => {}, onProgress = () => {} } = options;

  const analyzable = tracks.filter((t) => t?.filePath);
  if (!analyzable.length) return { analyzed: 0, failed: 0 };

  if (!isAnalysisAvailable()) {
    const reason = getAnalysisUnavailableReason();
    onLog(`Analysis engine unavailable, skipping analysis${reason ? ` (${reason})` : ""}.`);
    return { analyzed: 0, failed: 0 };
  }

  const concurrency = resolveAnalysisConcurrency();
  const total = analyzable.length;
  let completed = 0;
  let analyzed = 0;
  let failed = 0;

  onLog("");
  onLog(`Analyzing ${total} track${total === 1 ? "" : "s"} (BPM, key, energy, cue points)...`);

  await mapWithConcurrency(analyzable, concurrency, async (track) => {
    if (signal?.aborted) throw new Error("Cancelled");

    const startedAt = Date.now();
    try {
      const analysis = await analyzeTrack(track.filePath, { signal });
      track.analysis = analysis;
      analyzed += 1;

      const bpm = analysis.bpm ? `${analysis.bpm.toFixed(1)} BPM` : "BPM n/a";
      const key = analysis.camelot ? `${analysis.camelot} (${analysis.keyClassical})` : "key n/a";
      onLog(`  ${track.title}: ${bpm}, ${key}, energy ${analysis.energyLevel}/10, ${analysis.cues.length} cues`);

      recordDiagnostic({
        event: "analysis.track",
        ms: Date.now() - startedAt,
        bpm: analysis.bpm,
        camelot: analysis.camelot,
        cues: analysis.cues.length
      });
    } catch (err) {
      // Cancellation must stop the whole phase; anything else is this one track.
      if (signal?.aborted) throw err;
      failed += 1;
      onLog(`  ${track.title}: analysis failed (${err?.message ?? "unknown error"})`);
      recordDiagnostic({ event: "analysis.failed", ms: Date.now() - startedAt, message: err?.message });
    } finally {
      completed += 1;
      onProgress({ current: completed, total, title: track.title ?? "" });
    }
  });

  return { analyzed, failed };
}

/**
 * Attach a DJ style to every track, in place.
 *
 * Deliberately independent of whether the audio analysis succeeded. An upload
 * titled "Melodic Techno Mix" states its style whether or not Essentia loaded or
 * that particular file decoded, and the set builder is far more useful with a
 * style than without one. Measured features only come into it as a fallback.
 *
 * @param {Array<object>} tracks
 * @param {{ onLog?: (line: string) => void }} [options]
 * @returns {{ asserted: number, inferred: number, unknown: number }}
 */
export function classifyTracks(tracks, options = {}) {
  const { onLog = () => {} } = options;
  const counts = { asserted: 0, inferred: 0, unknown: 0 };

  for (const track of tracks) {
    if (!track) continue;

    const result = detectStyle({
      ...(track.styleHints ?? {}),
      bpm: track.analysis?.bpm ?? null,
      energyLevel: track.analysis?.energyLevel ?? null
    });

    track.style = result;
    if (result.source === "metadata") counts.asserted += 1;
    else if (result.source === "inferred") counts.inferred += 1;
    else counts.unknown += 1;
  }

  if (counts.asserted || counts.inferred) {
    onLog("");
    onLog(
      `Styles: ${counts.asserted} from metadata, ${counts.inferred} inferred from tempo, ${counts.unknown} undetermined.`
    );
    for (const track of tracks) {
      if (!track?.style?.style) continue;
      const qualifier = track.style.source === "inferred" ? " (inferred)" : "";
      onLog(`  ${track.title}: ${track.style.style}${qualifier}`);
    }
  }

  return counts;
}
