/**
 * Process-wide diagnostic sink. Off by default in the CLI; the Electron main
 * process installs a file-backed sink at startup so a freeze leaves evidence.
 *
 * Kept dependency-free and non-throwing: diagnostics must never be able to fail a run.
 */

/** @typedef {{ event: string, ms?: number, [key: string]: unknown }} DiagnosticRecord */

/** @type {((record: DiagnosticRecord & { at: string }) => void) | null} */
let sink = null;

/**
 * @param {((record: DiagnosticRecord & { at: string }) => void) | null} fn
 */
export function setDiagnosticSink(fn) {
  sink = typeof fn === "function" ? fn : null;
}

/**
 * @param {DiagnosticRecord} record
 */
export function recordDiagnostic(record) {
  if (!sink) return;
  try {
    sink({ at: new Date().toISOString(), ...record });
  } catch {
    /* a broken sink must not break the pipeline */
  }
}

/**
 * Collapse an argv into something loggable: keeps flags, drops URLs and paths
 * that would make the log noisy or leak the output directory.
 * @param {string[]} args
 */
export function summarizeArgs(args) {
  if (!Array.isArray(args)) return "";
  return args
    .map((a) => {
      const s = String(a);
      if (/^https?:\/\//i.test(s)) return "<url>";
      if (s.includes("/") || s.includes("\\")) return "<path>";
      return s;
    })
    .join(" ")
    .slice(0, 300);
}
