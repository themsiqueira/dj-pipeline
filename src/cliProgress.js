import { createProgressModel, describeProgress } from "./progress.js";

/**
 * A one-line progress bar for the terminal.
 *
 * Two things make this safe to leave on. It only draws when stderr is a terminal,
 * so piping to a file or a CI log gets clean output with no escape codes. And log
 * lines go through the same writer as the bar, which erases itself before each
 * one and redraws after — otherwise the two fight over the same line and the
 * result is a smear of half-overwritten text.
 *
 * Redraws are capped at roughly 10 per second. A 40-track run emits progress far
 * more often than that, and past a few frames per second the writes cost more
 * than they tell anyone.
 */

const MIN_REDRAW_MS = 100;
const BAR_WIDTH = 24;
const FILLED = "█";
const EMPTY = "░";
/** Carriage return, then erase to end of line. */
const CLEAR_LINE = "\r\u001b[2K";

function renderBar(fraction) {
  const filled = Math.round(fraction * BAR_WIDTH);
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

/**
 * @param {object} [options]
 * @param {NodeJS.WriteStream} [options.stream] where the bar is drawn
 * @param {NodeJS.WriteStream} [options.logStream] where log lines go
 * @param {{ source?: "url" | "local", analyze?: boolean, setOrder?: boolean }} [options.shape]
 */
export function createCliReporter(options = {}) {
  const {
    stream = process.stderr,
    logStream = process.stdout,
    shape = {},
    enabled = Boolean(process.stderr.isTTY)
  } = options;

  const model = createProgressModel(shape);
  let lastDrawAt = 0;
  let drawn = false;
  let started = false;
  let lastLabel = "";
  let trailing = null;

  const compose = () => {
    const { fraction, indeterminate } = model.state;
    const head = indeterminate
      ? `[${EMPTY.repeat(BAR_WIDTH)}]   ..`
      : `[${renderBar(fraction)}] ${String(Math.round(fraction * 100)).padStart(3)}%`;
    return `${head}  ${lastLabel}`;
  };

  const cancelTrailing = () => {
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
  };

  const erase = () => {
    if (!enabled || !drawn) return;
    stream.write(CLEAR_LINE);
    drawn = false;
  };

  /** Always composed fresh, so a redraw can never resurrect a stale frame. */
  const paint = () => {
    // Truncated to the terminal so a long track title does not wrap and leave the
    // previous frame stranded on the line above.
    const width = Math.max(20, (stream.columns || 80) - 1);
    stream.write(CLEAR_LINE + compose().slice(0, width));
    drawn = true;
    lastDrawAt = Date.now();
  };

  return {
    /** Log lines own the scrollback; the bar always steps aside for them. */
    log(line) {
      cancelTrailing();
      erase();
      logStream.write(`${line}\n`);
      if (enabled && started) paint();
    },

    progress(event) {
      model.update(event);
      const label = describeProgress(event);
      if (label) lastLabel = label;
      if (!enabled) return;
      started = true;

      if (Date.now() - lastDrawAt >= MIN_REDRAW_MS) {
        cancelTrailing();
        paint();
        return;
      }
      // Without this, the last event of a burst is dropped and the bar sits at a
      // stale percentage until something else happens to redraw it.
      if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          paint();
        }, MIN_REDRAW_MS);
        trailing.unref?.();
      }
    },

    /** Draws the final state unthrottled, then gives the line back to the shell. */
    finish(message) {
      cancelTrailing();
      if (!enabled) {
        if (message) logStream.write(`${message}\n`);
        return;
      }
      model.complete();
      if (message) lastLabel = message;
      paint();
      stream.write("\n");
      drawn = false;
      started = false;
    },

    /** Removes the bar without claiming the run finished. */
    clear() {
      cancelTrailing();
      erase();
      started = false;
    }
  };
}
