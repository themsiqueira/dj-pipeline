import fs from "fs";
import path from "path";
import { ensureDir, join } from "./util.js";
import { getYtDlpExecutable, getFfmpegExecutable } from "./binaries.js";
import { spawnTracked } from "./spawnUtil.js";
import { classifyPipelineUrl, isYouTubeUrl } from "./urlPolicy.js";
import { pipelineError, PIPELINE_ERROR, looksGeoRestricted } from "./pipelineErrors.js";
import { withRetry, isRetryableToolError, createLimiter } from "./concurrency.js";
import { sourceNetworkArgs } from "./networkArgs.js";

/**
 * Single choke point for yt-dlp launches. Sized by the pipeline so the pool width,
 * not each call site, decides how much load the sources see.
 */
let toolLimiter = createLimiter(1);

export function configureYtDlpConcurrency(max) {
  toolLimiter = createLimiter(max);
}

/**
 * @param {() => Promise<T>} fn
 * @param {{ signal?: AbortSignal, onLog?: (line: string) => void, what?: string }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export function runYtDlp(fn, options = {}) {
  const { signal, onLog, what = "yt-dlp" } = options;
  return toolLimiter.run(() =>
    withRetry(fn, {
      signal,
      isRetryable: isRetryableToolError,
      onRetry: ({ attempt, delayMs }) => {
        onLog?.(`  ${what} failed (attempt ${attempt}); retrying in ${Math.round(delayMs / 1000)}s...`);
      }
    })
  );
}

/** Default YouTube player clients; retry downloads may use {@link YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT}. */
const DEFAULT_YOUTUBE_PLAYER_CLIENT = "web_embedded,default";

/**
 * Extra yt-dlp CLI tokens for YouTube (SABR/403 workarounds). Keep yt-dlp updated: `pip install -U yt-dlp`.
 * Set `YTDLP_COOKIES_FROM_BROWSER` (e.g. `chrome`) if downloads still return 403.
 */
export function youtubeYtDlpArgs(playerClientSpec = DEFAULT_YOUTUBE_PLAYER_CLIENT) {
  const args = ["--extractor-args", `youtube:player_client=${playerClientSpec}`];
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (browser) {
    args.push("--cookies-from-browser", browser);
  }
  return args;
}

/** Alternate player_client list for a single retry after HTTP 403 on the media URL. */
export const YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT = "android,web";

function stderrLooksLike403Forbidden(err) {
  const text = [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
  return /403|Forbidden/i.test(text);
}

/**
 * Single video/track flat JSON is the media dict itself; playlists return `{ entries: [...] }`.
 * @param {object} data
 * @param {string} playlistUrl
 */
export function normalizeFlatPlaylistPayload(data, playlistUrl) {
  if (data == null || typeof data !== "object") {
    throw new Error(`Failed to fetch playlist: invalid response\nURL: ${playlistUrl}`);
  }
  if (Array.isArray(data.entries) && data.entries.length > 0) {
    return data;
  }
  // Empty playlist/set: top-level `id` is often the playlist id — do not treat as one track.
  if (data._type === "playlist") {
    return { ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
  }
  // `data.url` here is the resolved media stream (googlevideo/cdn), not a page URL:
  // passing it back to yt-dlp would hit the generic extractor. Only page URLs are usable.
  const url = typeof data.url === "string" ? data.url.trim() : "";
  const webpage = typeof data.webpage_url === "string" ? data.webpage_url.trim() : "";
  const id = data.id != null && String(data.id).trim() !== "" ? String(data.id).trim() : "";
  if (id || url || webpage) {
    return {
      ...data,
      entries: [
        {
          id: data.id,
          title: data.title,
          url: webpage || playlistUrl,
          webpage_url: webpage || playlistUrl,
          uploader: data.uploader,
          channel: data.channel,
          channel_id: data.channel_id,
          artist: data.artist,
          upload_date: data.upload_date,
          release_year: data.release_year
        }
      ]
    };
  }
  return { ...data, entries: [] };
}

/**
 * @param {string} playlistUrl
 * @param {string[]} [extraArgs]
 * @param {AbortSignal} [signal]
 */
export async function ytDlpJson(playlistUrl, extraArgs = [], signal) {
  const { site, mode } = classifyPipelineUrl(playlistUrl);
  const playlistScope = mode === "single" ? ["--no-playlist"] : ["--yes-playlist"];
  const youtubeArgs = site === "youtube" ? youtubeYtDlpArgs() : [];
  const args = [
    "--dump-single-json",
    ...playlistScope,
    "--flat-playlist",
    ...sourceNetworkArgs(),
    ...youtubeArgs,
    ...extraArgs,
    playlistUrl
  ];

  const yt = getYtDlpExecutable();
  try {
    const { stdout } = await runYtDlp(() => spawnTracked(yt, args, { signal }), {
      signal,
      what: "Playlist fetch"
    });
    const data = JSON.parse(stdout);
    if (data === null) {
      throw new Error(`Failed to fetch playlist: empty response\nURL: ${playlistUrl}`);
    }
    return normalizeFlatPlaylistPayload(data, playlistUrl);
  } catch (error) {
    if (error?.message === "Cancelled") throw error;
    const errorMsg = error.stderr?.toString() || error.message || "Unknown error";
    throw pipelineError(
      looksGeoRestricted(error) ? PIPELINE_ERROR.GEO_RESTRICTED : PIPELINE_ERROR.PLAYLIST_FETCH,
      `Failed to fetch playlist: ${errorMsg}\nURL: ${playlistUrl}`
    );
  }
}

/**
 * @param {string} videoUrl
 * @param {string[]} [extraArgs]
 * @param {AbortSignal} [signal]
 */
export async function ytDlpVideoJson(videoUrl, extraArgs = [], signal) {
  const { site, mode } = classifyPipelineUrl(videoUrl);
  const playlistScope = mode === "single" ? ["--no-playlist"] : [];
  const youtubeArgs = site === "youtube" ? youtubeYtDlpArgs() : [];
  const args = [
    "--dump-single-json",
    ...playlistScope,
    ...sourceNetworkArgs(),
    ...youtubeArgs,
    ...extraArgs,
    videoUrl
  ];
  const yt = getYtDlpExecutable();
  try {
    const { stdout } = await runYtDlp(() => spawnTracked(yt, args, { signal }), {
      signal,
      what: "Metadata fetch"
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.message === "Cancelled") throw error;
    const errorMsg = error.stderr?.toString() || error.message || "Unknown error";
    throw pipelineError(
      looksGeoRestricted(error) ? PIPELINE_ERROR.GEO_RESTRICTED : PIPELINE_ERROR.VIDEO_METADATA,
      `Failed to fetch video metadata: ${errorMsg}\nURL: ${videoUrl}`
    );
  }
}

export function buildVideoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * One yt-dlp invocation produces the audio, the full metadata JSON, and the cover art.
 * Previously these were two or three separate launches, and yt-dlp costs ~11 s of
 * startup each time regardless of how little work it does.
 *
 * @param {string} mediaUrl
 * @param {string} workDir a directory used exclusively by this track
 * @param {{ signal?: AbortSignal, wantThumbnail?: boolean, onLog?: (line: string) => void }} [options]
 * @returns {Promise<{ audioPath: string, info: object | null, thumbnailPath: string | null }>}
 */
export async function downloadTrackBundle(mediaUrl, workDir, options = {}) {
  const { signal, wantThumbnail = true, onLog } = options;
  ensureDir(workDir);

  const stem = "media";
  const ffmpeg = getFfmpegExecutable();
  const youtube = isYouTubeUrl(mediaUrl);

  const argsFor = (playerClientSpec) => [
    "--no-warnings",
    "--no-progress",
    "--no-playlist",
    ...sourceNetworkArgs(),
    ...(youtube ? youtubeYtDlpArgs(playerClientSpec) : []),
    "-f",
    "bestaudio/best",
    "--write-info-json",
    ...(wantThumbnail ? ["--write-thumbnail", "--convert-thumbnails", "jpg"] : []),
    // yt-dlp shells out to ffmpeg for the jpg conversion and only looks on PATH,
    // so a bundled binary has to be pointed at explicitly or cover art is lost.
    ...(path.isAbsolute(ffmpeg) ? ["--ffmpeg-location", ffmpeg] : []),
    "-o",
    join(workDir, `${stem}.%(ext)s`),
    mediaUrl
  ];

  const yt = getYtDlpExecutable();
  await runYtDlp(
    async () => {
      try {
        return await spawnTracked(yt, argsFor(), { signal });
      } catch (err) {
        if (err?.message === "Cancelled") throw err;
        if (!youtube || !stderrLooksLike403Forbidden(err)) throw err;
        // A 403 from the CDN usually means this player client's URLs were rejected;
        // a different client often works without any backoff.
        return spawnTracked(yt, argsFor(YOUTUBE_YTDLP_RETRY_PLAYER_CLIENT), { signal });
      }
    },
    { signal, onLog, what: "Download" }
  );

  const names = await fs.promises.readdir(workDir);
  let audioPath = null;
  let infoPath = null;
  let thumbnailPath = null;

  for (const name of names) {
    const full = join(workDir, name);
    if (name.endsWith(".info.json")) {
      infoPath = full;
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      // Prefer the converted jpg; ffmpeg embeds it directly.
      if (!thumbnailPath || ext === ".jpg") thumbnailPath = full;
      continue;
    }
    if (!audioPath) audioPath = full;
  }

  if (!audioPath) {
    throw new Error(`Download failed for ${mediaUrl}`);
  }

  let info = null;
  if (infoPath) {
    try {
      info = JSON.parse(await fs.promises.readFile(infoPath, "utf-8"));
    } catch {
      info = null;
    }
  }

  return { audioPath, info, thumbnailPath };
}
