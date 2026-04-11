import path from "path";
import { runPlaylist, normalizePlaylistUrl, assertValidPipelineUrl } from "./pipeline.js";
import { toPipelineError, PIPELINE_ERROR } from "./pipelineErrors.js";

let playlistUrl = process.argv[2];
if (!playlistUrl) {
  console.error("Usage: npm run run -- <youtube_or_soundcloud_playlist_or_track_url>");
  process.exit(1);
}

playlistUrl = normalizePlaylistUrl(playlistUrl);

try {
  assertValidPipelineUrl(playlistUrl);
} catch (error) {
  console.error(`Error: ${error.message}`);
  console.error("Please provide a valid YouTube or SoundCloud URL (playlist, set, or single track).");
  process.exit(1);
}

const outputRoot = path.resolve("output");
const ac = new AbortController();

try {
  const summary = await runPlaylist({
    playlistUrl,
    outputRoot,
    signal: ac.signal,
    onLog: (line) => console.log(line)
  });

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
  const { code, message } = toPipelineError(error);
  console.error(message || error);
  if (code === PIPELINE_ERROR.TOOLS_UNAVAILABLE) {
    console.error("(Setup: install yt-dlp and ffmpeg, or set YOUTUBE_DJ_YTDLP / YOUTUBE_DJ_FFMPEG.)");
  } else if (code === PIPELINE_ERROR.PLAYLIST_FETCH) {
    console.error("(If this is a private playlist, try cookies or check the URL.)");
  }
  process.exit(1);
}
