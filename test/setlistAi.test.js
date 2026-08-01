import test from "node:test";
import assert from "node:assert/strict";

import { enrichTransitions, resolveAiConfig, buildPrompt } from "../src/setlist/ai.js";

function transition(overrides = {}) {
  return {
    fromTrack: {
      title: "Secret Track Name",
      filePath: "/Users/someone/Music/secret.mp3",
      comment: "Source: https://youtube.com/watch?v=private",
      analysis: { bpm: 128.04, camelot: "8A", energyLevel: 6 },
      style: { style: "melodic techno", source: "metadata" }
    },
    toTrack: {
      title: "Another Private Title",
      filePath: "/Users/someone/Music/other.mp3",
      analysis: { bpm: 130.2, camelot: "9A", energyLevel: 8 },
      style: { style: "techno", source: "metadata" }
    },
    key: { move: "+1 (fifth up)", score: 0.95 },
    bpm: { percent: 1.69, score: 0.9 },
    energy: { delta: 2 },
    ...overrides
  };
}

/** Swap in a fake fetch for the duration of one call. */
async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function completion(notes) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify({ notes }) } }] });
}

test("no API key means the layer is simply skipped", async () => {
  const result = await enrichTransitions([transition()], { env: {} });
  assert.equal(result.size, 0);
});

/** No saved settings, so the outcome does not depend on the machine running the test. */
const NO_STORED = {};

test("either key variable is accepted", () => {
  assert.equal(resolveAiConfig({ OPENAI_API_KEY: "sk-a" }, NO_STORED)?.apiKey, "sk-a");
  assert.equal(resolveAiConfig({ YOUTUBE_DJ_AI_API_KEY: "sk-b" }, NO_STORED)?.apiKey, "sk-b");
  assert.equal(resolveAiConfig({ OPENAI_API_KEY: "   " }, NO_STORED), null);
  assert.equal(resolveAiConfig({}, NO_STORED), null);
});

test("base URL and model are overridable, and the URL loses a trailing slash", () => {
  const config = resolveAiConfig(
    {
      OPENAI_API_KEY: "sk-a",
      YOUTUBE_DJ_AI_BASE_URL: "https://example.test/v1/",
      YOUTUBE_DJ_AI_MODEL: "some-model"
    },
    NO_STORED
  );
  assert.equal(config.baseUrl, "https://example.test/v1");
  assert.equal(config.model, "some-model");
});

test("a key saved in Settings is used when the environment has none", () => {
  const config = resolveAiConfig({}, { apiKey: "sk-saved", model: "saved-model" });

  assert.equal(config.apiKey, "sk-saved");
  assert.equal(config.model, "saved-model");
});

test("the environment overrides a saved key for one run", () => {
  const config = resolveAiConfig({ OPENAI_API_KEY: "sk-env" }, { apiKey: "sk-saved" });

  assert.equal(config.apiKey, "sk-env");
});

test("the payload carries measured values only", () => {
  const payload = buildPrompt([transition()]);
  const serialised = JSON.stringify(payload);

  // The privacy boundary this module claims, asserted rather than assumed.
  assert.ok(!serialised.includes("Secret Track Name"), "track titles must not be sent");
  assert.ok(!serialised.includes("Another Private Title"), "track titles must not be sent");
  assert.ok(!serialised.includes("/Users/"), "file paths must not be sent");
  assert.ok(!serialised.includes("youtube.com"), "source URLs must not be sent");

  assert.equal(payload[0].from.bpm, 128);
  assert.equal(payload[0].from.key, "8A");
  assert.equal(payload[0].to.energy, 8);
  assert.equal(payload[0].keyMove, "+1 (fifth up)");
});

test("advice is returned keyed by transition index", async () => {
  const notes = await withFetch(
    async () => completion([{ index: 0, advice: "Ride the high-pass into the drop." }]),
    () => enrichTransitions([transition()], { env: { OPENAI_API_KEY: "sk-test" } })
  );

  assert.equal(notes.get(0), "Ride the high-pass into the drop.");
});

test("out-of-range indices from the model are discarded", async () => {
  const notes = await withFetch(
    async () =>
      completion([
        { index: 0, advice: "Good." },
        { index: 9, advice: "For a transition that does not exist." },
        { index: -1, advice: "Negative." },
        { index: "x", advice: "Not a number." }
      ]),
    () => enrichTransitions([transition()], { env: { OPENAI_API_KEY: "sk-test" } })
  );

  assert.equal(notes.size, 1);
  assert.equal(notes.get(0), "Good.");
});

test("advice is flattened to one line and capped", async () => {
  const notes = await withFetch(
    async () => completion([{ index: 0, advice: `line one\n\nline two ${"x".repeat(500)}` }]),
    () => enrichTransitions([transition()], { env: { OPENAI_API_KEY: "sk-test" } })
  );

  const advice = notes.get(0);
  assert.ok(!advice.includes("\n"), "a newline would break the markdown blockquote");
  assert.ok(advice.length <= 240, `advice was ${advice.length} characters`);
});

test("a rejected key degrades quietly to the rule-based notes", async () => {
  const logs = [];
  const notes = await withFetch(
    async () => jsonResponse({ error: "unauthorized" }, 401),
    () =>
      enrichTransitions([transition()], {
        env: { OPENAI_API_KEY: "sk-bad" },
        onLog: (line) => logs.push(line)
      })
  );

  assert.equal(notes.size, 0);
  assert.ok(logs.some((l) => /API key was rejected/.test(l)));
});

test("a network failure does not propagate", async () => {
  const notes = await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    () => enrichTransitions([transition()], { env: { OPENAI_API_KEY: "sk-test" } })
  );
  assert.equal(notes.size, 0);
});

test("malformed JSON from the model does not propagate", async () => {
  const notes = await withFetch(
    async () => jsonResponse({ choices: [{ message: { content: "not json at all" } }] }),
    () => enrichTransitions([transition()], { env: { OPENAI_API_KEY: "sk-test" } })
  );
  assert.equal(notes.size, 0);
});

test("an empty response body does not propagate", async () => {
  const notes = await withFetch(
    async () => jsonResponse({ choices: [] }),
    () => enrichTransitions([transition()], { env: { OPENAI_API_KEY: "sk-test" } })
  );
  assert.equal(notes.size, 0);
});

test("cancellation is not swallowed like an ordinary failure", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      withFetch(
        async () => {
          throw new Error("aborted");
        },
        () =>
          enrichTransitions([transition()], {
            env: { OPENAI_API_KEY: "sk-test" },
            signal: controller.signal
          })
      ),
    "an aborted run must stop, not continue as though the AI merely failed"
  );
});

test("no transitions means no request is made", async () => {
  let called = false;
  const notes = await withFetch(
    async () => {
      called = true;
      return completion([]);
    },
    () => enrichTransitions([], { env: { OPENAI_API_KEY: "sk-test" } })
  );

  assert.equal(notes.size, 0);
  assert.equal(called, false);
});

test("the request is addressed and authorised correctly", async () => {
  let seenUrl = null;
  let seenInit = null;

  await withFetch(
    async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return completion([]);
    },
    () =>
      enrichTransitions([transition()], {
        env: { OPENAI_API_KEY: "sk-test", YOUTUBE_DJ_AI_BASE_URL: "https://example.test/v1" }
      })
  );

  assert.equal(seenUrl, "https://example.test/v1/chat/completions");
  assert.equal(seenInit.headers.Authorization, "Bearer sk-test");
  assert.equal(seenInit.method, "POST");
  assert.ok(seenInit.signal, "the request must be abortable");
});
