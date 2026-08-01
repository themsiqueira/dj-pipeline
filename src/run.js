import fs from "fs";
import path from "path";
import {
  runPlaylist,
  runLocalTracks,
  normalizePlaylistUrl,
  assertValidPipelineUrl
} from "./pipeline.js";
import { toPipelineError, PIPELINE_ERROR } from "./pipelineErrors.js";
import { AUDIO_FORMAT, DEFAULT_AUDIO_FORMAT } from "./audioFormats.js";
import { killAllPipelineChildren } from "./pipelineChildren.js";
import { createCliReporter } from "./cliProgress.js";

const USAGE =
  "Usage: npm run run -- <url_or_local_path> [--format=mp3|flac] [--analyze] [--beatgrid] [--set-order]\n" +
  "  url         a YouTube, SoundCloud or Spotify playlist, album or track\n" +
  "  local path  a folder or audio file you already own; analysed in place";

const args = process.argv.slice(2);
const formatArg = args.find((a) => a.startsWith("--format="));
// Rekordbox detects grids well on 4/4 material, and an imported grid that is one
// beat out is worse than none, so this stays opt-in even when analysing.
const includeBeatgrid = args.includes("--beatgrid");
// Ordering needs the tempo, key and energy of every track, so it cannot run
// without the analysis phase.
const setOrder = args.includes("--set-order");
const positional = args.filter((a) => !a.startsWith("--"));

const target = positional[0];
if (!target) {
  console.error(USAGE);
  process.exit(1);
}

/**
 * A path that exists is a local library; anything else is a URL. Checking the
 * disk rather than pattern-matching means "./Techno" and "C:\Music" need no
 * flag, and a typo'd URL still gets the URL error message rather than a
 * confusing "no audio files found".
 */
const isLocal = (() => {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
})();

// Analysis is the entire job locally. Elsewhere, asking for anything derived from
// it asks for it too: requiring --analyze alongside would only turn a forgotten
// flag into a silent no-op.
const analyze = isLocal || args.includes("--analyze") || includeBeatgrid || setOrder;

const allowedFormats = Object.values(AUDIO_FORMAT);
const audioFormat = formatArg
  ? formatArg.slice("--format=".length).trim().toLowerCase()
  : DEFAULT_AUDIO_FORMAT;
if (!allowedFormats.includes(audioFormat)) {
  console.error(`Error: unknown format "${audioFormat}". Use one of: ${allowedFormats.join(", ")}.`);
  process.exit(1);
}

let playlistUrl = "";
if (!isLocal) {
  playlistUrl = normalizePlaylistUrl(target);
  try {
    assertValidPipelineUrl(playlistUrl);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(
      "Provide a valid YouTube, SoundCloud, or Spotify URL (playlist, album, set, or single track), " +
        "or a path to a folder or audio file that exists."
    );
    process.exit(1);
  }
}

const outputRoot = path.resolve("output");
const ac = new AbortController();

const reporter = createCliReporter({
  shape: { source: isLocal ? "local" : "url", analyze, setOrder }
});

// Children run in their own process group so cancel can reap yt-dlp's ffmpeg
// grandchild, which also means Ctrl+C no longer reaches them via the terminal.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    reporter.clear();
    console.error("\nStopping...");
    killAllPipelineChildren();
    ac.abort();
  });
}

try {
  const common = {
    outputRoot,
    signal: ac.signal,
    includeBeatgrid,
    setOrder,
    onLog: (line) => reporter.log(line),
    onProgress: (progress) => reporter.progress(progress)
  };

  const summary = isLocal
    ? await runLocalTracks({ ...common, inputPath: path.resolve(target) })
    : await runPlaylist({ ...common, playlistUrl, audioFormat, analyze });

  reporter.finish("Done");

  if (summary.notesPath) {
    console.log("");
    console.log(`Set notes: ${summary.notesPath}`);
  }

  if (summary.csvPath) {
    console.log("");
    console.log(`Failures CSV: ${summary.csvPath}`);
  }

  const { successCount, totalCount, failures } = summary;
  if (totalCount > 0 && successCount === 0) {
    console.error("");
    console.error("No tracks completed successfully (exit 1).");
    process.exit(1);
  }

  if (failures.length > 0) {
    console.log("");
    console.log(`Completed with ${failures.length} failed track(s), ${successCount} saved.`);
  }

  process.exit(0);
} catch (error) {
  reporter.clear();
  const { code, message } = toPipelineError(error);
  if (code === PIPELINE_ERROR.CANCELLED) {
    console.error("Cancelled.");
    process.exit(130);
  }
  console.error(message || error);
  if (code === PIPELINE_ERROR.TOOLS_UNAVAILABLE) {
    console.error("(Setup: install yt-dlp and ffmpeg, or set YOUTUBE_DJ_YTDLP / YOUTUBE_DJ_FFMPEG.)");
  } else if (code === PIPELINE_ERROR.PLAYLIST_FETCH) {
    console.error("(If this is a private playlist, try cookies or check the URL.)");
  } else if (code === PIPELINE_ERROR.GEO_RESTRICTED) {
    console.error(
      "(Blocked for your region. Route yt-dlp through a proxy, e.g. " +
        "YOUTUBE_DJ_PROXY=socks5://127.0.0.1:1080, or connect a VPN and retry.)"
    );
  }
  process.exit(1);
}
