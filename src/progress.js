/**
 * One number for the whole run.
 *
 * Each phase counts from 1 with its own total, so a bar driven straight off those
 * events restarts every time a phase changes. This folds them into a single
 * fraction, weighted by how long each phase actually takes, and only counts the
 * phases a given run will really execute — a download without analysis must still
 * reach 100%.
 *
 * Pure and synchronous. It holds a running maximum and nothing else, so the UI can
 * call it on every event without touching the DOM or the filesystem.
 */

/** Must match `PHASE` in pipeline.js; a test asserts they have not drifted apart. */
export const PROGRESS_PHASE = {
  FETCH: "fetch",
  DOWNLOAD: "download",
  SCAN: "scan",
  ANALYZE: "analyze",
  SET_ORDER: "setOrder"
};

/**
 * Relative costs, not percentages: they are normalised once the run's shape is
 * known. Downloading dominates a URL run because it waits on a remote server,
 * while a local run is nothing but analysis. Analysis is roughly 4% of each
 * track's length, but it runs on files already on disk, so against download time
 * it is small.
 */
const WEIGHTS = {
  url: { fetch: 3, download: 100, analyze: 20, setOrder: 4 },
  local: { scan: 5, analyze: 100, setOrder: 12 }
};

/**
 * @param {{ source?: "url" | "local", analyze?: boolean, setOrder?: boolean }} runShape
 * @returns {Record<string, number>} phase -> share of the run, summing to 1
 */
export function resolveWeights({ source = "url", analyze = false, setOrder = false } = {}) {
  const table = source === "local" ? WEIGHTS.local : WEIGHTS.url;
  /** @type {Record<string, number>} */
  const raw = {};

  if (source === "local") {
    raw[PROGRESS_PHASE.SCAN] = table.scan;
    raw[PROGRESS_PHASE.ANALYZE] = table.analyze;
  } else {
    raw[PROGRESS_PHASE.FETCH] = table.fetch;
    raw[PROGRESS_PHASE.DOWNLOAD] = table.download;
    if (analyze) raw[PROGRESS_PHASE.ANALYZE] = table.analyze;
  }
  if (setOrder) raw[PROGRESS_PHASE.SET_ORDER] = table.setOrder;

  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  /** @type {Record<string, number>} */
  const normalised = {};
  for (const [phase, weight] of Object.entries(raw)) normalised[phase] = weight / sum;
  return normalised;
}

/** The order phases run in, used to decide what is already behind us. */
const SEQUENCE = [
  PROGRESS_PHASE.FETCH,
  PROGRESS_PHASE.SCAN,
  PROGRESS_PHASE.DOWNLOAD,
  PROGRESS_PHASE.ANALYZE,
  PROGRESS_PHASE.SET_ORDER
];

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * @param {{ source?: "url" | "local", analyze?: boolean, setOrder?: boolean }} [runShape]
 */
export function createProgressModel(runShape = {}) {
  const weights = resolveWeights(runShape);
  // Normalised shares are repeating fractions, so adding them back up lands a
  // whisker under one. Naming the final phase lets its completion mean 100%
  // exactly, instead of a bar that stops one pixel short forever.
  const lastPhase = SEQUENCE.filter((phase) => weights[phase] > 0).pop();
  // A URL run cannot know its size until the playlist has been listed, and that
  // request can take many seconds. Claiming 0% for that whole time reads as a
  // hang, so the bar says "working" instead until the first real count arrives.
  let indeterminate = runShape.source !== "local";
  let fraction = 0;

  return {
    get weights() {
      return { ...weights };
    },

    /**
     * @param {{ phase?: string, current?: number, total?: number }} event
     * @returns {{ fraction: number, indeterminate: boolean }}
     */
    update(event = {}) {
      const phase = String(event.phase ?? "");
      const total = Number(event.total) || 0;
      // Fractional values are expected: a single track reports partial progress
      // through its own download, encode and tag steps.
      const current = clamp01(total > 0 ? Number(event.current) / total : 0);

      const index = SEQUENCE.indexOf(phase);
      // An unrecognised phase changes nothing rather than resetting the bar.
      if (index < 0) return { fraction, indeterminate };
      indeterminate = false;

      let completed = 0;
      for (const earlier of SEQUENCE.slice(0, index)) completed += weights[earlier] ?? 0;

      const reached =
        phase === lastPhase && current >= 1 ? 1 : completed + (weights[phase] ?? 0) * current;

      // Monotonic by construction. Phases finish out of order under a worker pool,
      // and a bar that slides backwards looks broken even when the run is fine.
      fraction = Math.max(fraction, clamp01(reached));

      return { fraction, indeterminate };
    },

    /** Called when the run ends so the bar lands on a full 100% rather than 97%. */
    complete() {
      indeterminate = false;
      fraction = 1;
      return { fraction, indeterminate };
    },

    get state() {
      return { fraction, indeterminate };
    }
  };
}

/**
 * The words that go with the number. Shared so the desktop app and the CLI cannot
 * describe the same event differently.
 *
 * @param {{ phase?: string, current?: number, total?: number, title?: string }} event
 * @returns {string}
 */
export function describeProgress(event = {}) {
  const { phase, current, total, title } = event;
  const position = total > 0 ? `${Math.min(Math.ceil(Number(current) || 0), total)} of ${total}` : "";
  const named = String(title ?? "").trim();

  if (phase === PROGRESS_PHASE.SET_ORDER) return "Working out a set order";
  if (phase === PROGRESS_PHASE.SCAN) {
    return position ? `Reading track ${position}` : "Reading tracks";
  }
  if (phase === PROGRESS_PHASE.ANALYZE) {
    const head = position ? `Analyzing ${position}` : "Analyzing";
    return named ? `${head}: ${named}` : head;
  }
  if (phase === PROGRESS_PHASE.DOWNLOAD) {
    const head = position ? `Track ${position}` : "Downloading";
    return named ? `${head}: ${named}` : head;
  }
  return named;
}
