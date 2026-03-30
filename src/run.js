import path from "path";
import {
  runPlaylist,
  normalizePlaylistUrl,
  assertValidYouTubePlaylistUrl
} from "./pipeline.js";

let playlistUrl = process.argv[2];
if (!playlistUrl) {
  console.error("Usage: npm run run -- <youtube_playlist_url>");
  process.exit(1);
}

playlistUrl = normalizePlaylistUrl(playlistUrl);

try {
  assertValidYouTubePlaylistUrl(playlistUrl);
} catch (error) {
  console.error(`Error: ${error.message}`);
  console.error("Please provide a valid YouTube playlist URL");
  process.exit(1);
}

const outputRoot = path.resolve("output");
const ac = new AbortController();

try {
  await runPlaylist({
    playlistUrl,
    outputRoot,
    signal: ac.signal,
    onLog: (line) => console.log(line)
  });
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
