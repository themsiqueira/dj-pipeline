import { looksGeoRestricted } from "./pipelineErrors.js";

/** Abortable sleep. Rejects with `Cancelled` rather than resolving late. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * yt-dlp has no retry of its own here, and a single transient 429 or 5xx otherwise
 * fails a track permanently. Jitter matters once tracks run concurrently: without it
 * every worker retries in lockstep.
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ attempts?: number, baseMs?: number, maxMs?: number, signal?: AbortSignal, isRetryable?: (err: unknown) => boolean, onRetry?: (info: { attempt: number, delayMs: number, error: unknown }) => void }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseMs = 1500,
    maxMs = 20_000,
    signal,
    isRetryable = () => true,
    onRetry
  } = options;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new Error("Cancelled");
    try {
      return await fn(attempt);
    } catch (error) {
      if (error?.message === "Cancelled" || signal?.aborted) throw error;
      lastError = error;
      if (attempt === attempts - 1 || !isRetryable(error)) throw error;

      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const delayMs = Math.round(backoff * (0.5 + Math.random() * 0.5));
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

const RETRYABLE_PATTERNS = [
  /HTTP Error 429/i,
  /HTTP Error 5\d\d/i,
  /\btoo many requests\b/i,
  /sign in to confirm/i,
  /confirm you.?re not a bot/i,
  /temporary failure/i,
  /timed? out/i,
  /connection reset/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/,
  /unable to download (?:api page|webpage|video data)/i,
  /read error|incomplete read/i
];

/**
 * Deliberately conservative: retrying a genuinely unavailable or private video just
 * multiplies the wait before the failure lands in the CSV report.
 * @param {unknown} error
 */
export function isRetryableToolError(error) {
  const text = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .map(String)
    .join("\n");
  if (!text) return false;
  if (/private video|video unavailable|removed by the uploader|members-only|age-restricted/i.test(text)) {
    return false;
  }
  // A regional block is decided by our IP, so every attempt gets the same answer.
  if (looksGeoRestricted(error)) {
    return false;
  }
  return RETRYABLE_PATTERNS.some((re) => re.test(text));
}

/**
 * Counting semaphore. Used as the single choke point for tool launches so the pool
 * size, not the caller, decides how much load the sources see.
 * @param {number} max
 */
export function createLimiter(max) {
  const limit = Math.max(1, Math.floor(max) || 1);
  let active = 0;
  /** @type {(() => void)[]} */
  const queue = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return {
    get limit() {
      return limit;
    },
    /**
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     * @template T
     */
    async run(fn) {
      if (active >= limit) {
        await new Promise((resolve) => queue.push(resolve));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving input order
 * in the returned array regardless of completion order.
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 * @template T, R
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
