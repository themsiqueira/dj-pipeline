/**
 * Optional AI enrichment of the transition advice.
 *
 * Two deliberate limits.
 *
 * It does not reorder anything. An LLM asked to sequence a set gives a different
 * answer every time and cannot actually compare tempo distances, so the optimiser
 * owns the running order and the model only adds phrasing on top of decisions
 * already made.
 *
 * It sends numbers, not music. No audio, no titles, no artists, no URLs, no file
 * paths — just the measured tempo, key, energy and style of each pair. Transition
 * advice is a question about those numbers, so nothing identifying needs to leave
 * the machine to answer it.
 *
 * Absent a key it is skipped, and any failure falls back to the rule-based text
 * that is written either way.
 */

import { readUserConfig } from "../userConfig.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ADVICE_CHARS = 240;

const SYSTEM_PROMPT = [
  "You advise a hobbyist DJ on mixing one track into the next.",
  "You are given only measured values: tempo, Camelot key, an energy rating out of 10, and a style label.",
  "For each transition, give one or two sentences of practical advice a beginner can act on at the decks.",
  "Be concrete about technique and effects. Do not invent track names, artists or times.",
  "Do not suggest reordering the set. Do not repeat the numbers back."
].join(" ");

/**
 * Environment first, then the settings file the desktop app writes. That order
 * lets a shell override the saved key for one run, and lets a key entered in the
 * app's Settings screen work for the CLI too.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ apiKey?: string, baseUrl?: string, model?: string }} [stored]
 * @returns {{ apiKey: string, baseUrl: string, model: string } | null}
 */
export function resolveAiConfig(env = process.env, stored = readUserConfig().ai ?? {}) {
  const apiKey = env.YOUTUBE_DJ_AI_API_KEY || env.OPENAI_API_KEY || stored.apiKey || "";
  if (!String(apiKey).trim()) return null;

  const baseUrl = env.YOUTUBE_DJ_AI_BASE_URL || stored.baseUrl || DEFAULT_BASE_URL;
  return {
    apiKey: String(apiKey).trim(),
    baseUrl: String(baseUrl).replace(/\/+$/, ""),
    model: env.YOUTUBE_DJ_AI_MODEL || stored.model || DEFAULT_MODEL
  };
}

/**
 * The payload sent upstream. Exported so the privacy claim above is testable
 * rather than merely asserted in a comment.
 *
 * @param {Array<object>} transitions
 */
export function buildPrompt(transitions) {
  return transitions.map((transition, index) => ({
    index,
    from: {
      bpm: round(transition.fromTrack?.analysis?.bpm),
      key: transition.fromTrack?.analysis?.camelot ?? null,
      energy: transition.fromTrack?.analysis?.energyLevel ?? null,
      style: transition.fromTrack?.style?.style ?? null
    },
    to: {
      bpm: round(transition.toTrack?.analysis?.bpm),
      key: transition.toTrack?.analysis?.camelot ?? null,
      energy: transition.toTrack?.analysis?.energyLevel ?? null,
      style: transition.toTrack?.style?.style ?? null
    },
    keyMove: transition.key?.move ?? null,
    tempoGapPercent: round(transition.bpm?.percent),
    energyDelta: transition.energy?.delta ?? 0
  }));
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * A model's output goes straight into a markdown blockquote, so it is flattened
 * to a single line and capped rather than trusted verbatim.
 */
function sanitize(text) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat.length > MAX_ADVICE_CHARS ? `${flat.slice(0, MAX_ADVICE_CHARS - 1).trimEnd()}…` : flat;
}

/** @param {unknown} payload @returns {Map<number, string>} */
function parseNotes(payload, transitionCount) {
  const notes = new Map();
  const entries = Array.isArray(payload?.notes) ? payload.notes : [];

  for (const entry of entries) {
    const index = Number(entry?.index);
    if (!Number.isInteger(index) || index < 0 || index >= transitionCount) continue;

    const advice = sanitize(entry?.advice);
    if (advice) notes.set(index, advice);
  }

  return notes;
}

/**
 * @param {Array<object>} transitions
 * @param {{ signal?: AbortSignal, onLog?: (line: string) => void, env?: object }} [options]
 * @returns {Promise<Map<number, string>>} empty when unavailable or on any failure
 */
export async function enrichTransitions(transitions, options = {}) {
  const { signal, onLog = () => {}, env = process.env } = options;

  if (!Array.isArray(transitions) || transitions.length === 0) return new Map();

  const config = resolveAiConfig(env);
  if (!config) return new Map();

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // The user's cancel and the request timeout both have to be able to end this.
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    onLog(`Asking ${config.model} for transition advice (measured values only, no audio)...`);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      signal: abort,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              'Return JSON shaped {"notes":[{"index":<number>,"advice":"<text>"}]}',
              "with one entry per transition below.",
              JSON.stringify(buildPrompt(transitions))
            ].join(" ")
          }
        ]
      })
    });

    if (!response.ok) {
      const detail = response.status === 401 ? "the API key was rejected" : `HTTP ${response.status}`;
      onLog(`  AI advice unavailable (${detail}); keeping the rule-based notes.`);
      return new Map();
    }

    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (!content) {
      onLog("  AI advice came back empty; keeping the rule-based notes.");
      return new Map();
    }

    const notes = parseNotes(JSON.parse(content), transitions.length);
    onLog(`  Added AI advice to ${notes.size} of ${transitions.length} transitions.`);
    return notes;
  } catch (err) {
    // Cancellation is the caller's business; everything else is a soft failure,
    // because the rule-based notes are already complete on their own.
    if (signal?.aborted) throw err;
    onLog(`  AI advice failed (${err?.message ?? "unknown error"}); keeping the rule-based notes.`);
    return new Map();
  }
}
