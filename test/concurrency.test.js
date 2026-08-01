import test from "node:test";
import assert from "node:assert/strict";
import {
  mapWithConcurrency,
  createLimiter,
  withRetry,
  isRetryableToolError,
  sleep
} from "../src/concurrency.js";

test("mapWithConcurrency preserves input order despite completion order", async () => {
  const delays = [40, 5, 25, 1, 15];
  const out = await mapWithConcurrency(delays, 3, async (ms, i) => {
    await sleep(ms);
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
});

test("mapWithConcurrency never exceeds the requested width", async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, "expected some overlap");
});

test("mapWithConcurrency handles an empty list and a width above the list size", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async (x) => x * 2), [2, 4]);
});

test("createLimiter serialises beyond its limit", async () => {
  const limiter = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
      })
    )
  );
  assert.equal(peak, 2);
});

test("createLimiter releases its slot when the task throws", async () => {
  const limiter = createLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await limiter.run(async () => "ok"), "ok");
});

test("withRetry retries a retryable failure and then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("HTTP Error 429: Too Many Requests");
      return "done";
    },
    { baseMs: 1, isRetryable: isRetryableToolError }
  );
  assert.equal(result, "done");
  assert.equal(calls, 3);
});

test("withRetry gives up immediately on a non-retryable failure", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("Private video. Sign in if you've been granted access");
      },
      { baseMs: 1, isRetryable: isRetryableToolError }
    ),
    /Private video/
  );
  assert.equal(calls, 1);
});

test("withRetry stops at the attempt limit", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("HTTP Error 503");
      },
      { attempts: 3, baseMs: 1, isRetryable: isRetryableToolError }
    ),
    /503/
  );
  assert.equal(calls, 3);
});

test("cancellation is never retried", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("Cancelled");
      },
      { baseMs: 1 }
    ),
    /Cancelled/
  );
  assert.equal(calls, 1);
});

test("isRetryableToolError distinguishes transient from permanent", () => {
  const retryable = [
    "ERROR: HTTP Error 429: Too Many Requests",
    "ERROR: HTTP Error 503: Service Unavailable",
    "Sign in to confirm you're not a bot",
    "Unable to download webpage: timed out",
    "read ECONNRESET"
  ];
  for (const text of retryable) {
    assert.equal(isRetryableToolError(new Error(text)), true, text);
  }

  const permanent = [
    "ERROR: Private video",
    "ERROR: Video unavailable",
    "This video has been removed by the uploader",
    "Join this channel to get access to members-only content",
    ""
  ];
  for (const text of permanent) {
    assert.equal(isRetryableToolError(new Error(text)), false, text);
  }
});

test("isRetryableToolError reads stderr, not just the message", () => {
  const err = new Error("Process exited with code 1");
  err.stderr = "ERROR: HTTP Error 429: Too Many Requests";
  assert.equal(isRetryableToolError(err), true);
});

test("sleep rejects promptly when the signal aborts", async () => {
  const ac = new AbortController();
  const p = sleep(10_000, ac.signal);
  ac.abort();
  await assert.rejects(p, /Cancelled/);
});
