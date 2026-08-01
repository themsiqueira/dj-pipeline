/**
 * Runs the pipeline in an Electron utilityProcess so that no part of it can block
 * the main process. Everything here is a thin wrapper: `runPlaylist` keeps the exact
 * signature the CLI uses.
 *
 * Protocol with the parent:
 *   in : { type: "start", runId, mode, playlistUrl, inputPath, outputRoot, audioFormat,
 *           proxy, analyze, includeBeatgrid, setOrder }
 *        | { type: "cancel" }
 *   out: { type: "log", runId, line } | { type: "progress", runId, progress }
 *        | { type: "done", runId, result } | { type: "diag", record }
 */
import {
  runPlaylist,
  runLocalTracks,
  normalizePlaylistUrl,
  assertValidPipelineUrl
} from "../src/pipeline.js";
import { toPipelineError, PIPELINE_ERROR } from "../src/pipelineErrors.js";
import { killAllPipelineChildren } from "../src/pipelineChildren.js";
import { isSpotifyPipelineUrl } from "../src/urlPolicy.js";
import { loadSpotifyCredentials } from "../src/spotify/credentials.js";
import { setDiagnosticSink } from "../src/diagnostics.js";
import path from "path";

const port = process.parentPort;

/** @type {AbortController | null} */
let abortController = null;
let activeRunId = null;

function send(message) {
  try {
    port.postMessage(message);
  } catch {
    /* parent went away */
  }
}

setDiagnosticSink((record) => send({ type: "diag", record }));

async function start({
  runId,
  mode,
  playlistUrl,
  inputPath,
  outputRoot,
  audioFormat,
  proxy,
  analyze,
  includeBeatgrid,
  setOrder
}) {
  activeRunId = runId;
  abortController = new AbortController();

  // This process outlives a single run, so an emptied field must clear the previous
  // value rather than leave the old proxy in place.
  const proxyValue = typeof proxy === "string" ? proxy.trim() : "";
  if (proxyValue) {
    process.env.YOUTUBE_DJ_PROXY = proxyValue;
  } else {
    delete process.env.YOUTUBE_DJ_PROXY;
  }

  let root;
  try {
    root = path.resolve(String(outputRoot || "").trim() || ".");
  } catch {
    root = path.resolve(".");
  }

  const onLog = (line) => send({ type: "log", runId, line });
  const onProgress = (progress) => send({ type: "progress", runId, progress });

  try {
    let summary;
    if (mode === "local") {
      summary = await runLocalTracks({
        inputPath: String(inputPath ?? ""),
        outputRoot: root,
        signal: abortController.signal,
        includeBeatgrid: Boolean(includeBeatgrid),
        setOrder: Boolean(setOrder),
        onLog,
        onProgress
      });
    } else {
      const normalized = normalizePlaylistUrl(playlistUrl);
      assertValidPipelineUrl(normalized);
      if (isSpotifyPipelineUrl(normalized)) {
        loadSpotifyCredentials();
      }

      summary = await runPlaylist({
        playlistUrl: normalized,
        outputRoot: root,
        signal: abortController.signal,
        audioFormat,
        analyze: Boolean(analyze),
        includeBeatgrid: Boolean(includeBeatgrid),
        setOrder: Boolean(setOrder),
        onLog,
        onProgress
      });
    }

    send({
      type: "done",
      runId,
      result: {
        ok: true,
        outputRoot: root,
        failures: summary.failures,
        csvPath: summary.csvPath,
        xmlPath: summary.xmlPath,
        notesPath: summary.notesPath,
        successCount: summary.successCount,
        totalCount: summary.totalCount
      }
    });
  } catch (e) {
    const { code, message } = toPipelineError(e);
    send({
      type: "done",
      runId,
      result: {
        ok: false,
        error: message,
        code,
        cancelled: code === PIPELINE_ERROR.CANCELLED,
        outputRoot: root
      }
    });
  } finally {
    activeRunId = null;
    abortController = null;
  }
}

port.on("message", (event) => {
  const message = event?.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "cancel") {
    killAllPipelineChildren();
    abortController?.abort();
    return;
  }

  if (message.type === "start") {
    if (activeRunId !== null) return;
    start(message);
  }
});

port.start?.();
