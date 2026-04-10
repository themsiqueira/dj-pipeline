import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getYtDlpExecutable, getFfmpegExecutable } from "./binaries.js";

export const TOOL_SETUP_HINT =
  "Install yt-dlp and ffmpeg on your PATH, or set YOUTUBE_DJ_YTDLP and YOUTUBE_DJ_FFMPEG to their full executable paths. " +
  "For the desktop app, run npm run fetch-tools and rebuild on the target OS so vendor/ is bundled in the installer.";

function looksLikeFilesystemPath(cmd) {
  if (path.isAbsolute(cmd)) {
    return true;
  }
  return cmd.includes(path.sep) || /^[A-Za-z]:[\\/]/.test(cmd);
}

/** FFmpeg uses `-version`; yt-dlp uses `--version`. */
const YTDLP_VERSION_ARGS = ["--version"];
const FFMPEG_VERSION_ARGS = ["-hide_banner", "-version"];

/**
 * @param {string} label
 * @param {string} cmd
 * @param {string[]} [versionArgs]
 * @returns {{ ok: boolean, command: string, error?: string }}
 */
export function probeTool(label, cmd, versionArgs = YTDLP_VERSION_ARGS) {
  if (looksLikeFilesystemPath(cmd) && !fs.existsSync(cmd)) {
    return {
      ok: false,
      command: cmd,
      error: `${label} not found at "${cmd}". ${TOOL_SETUP_HINT}`
    };
  }
  try {
    execFileSync(cmd, versionArgs, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000
    });
    return { ok: true, command: cmd };
  } catch (e) {
    if (e?.code === "ENOENT") {
      return {
        ok: false,
        command: cmd,
        error: `${label} is not installed or not reachable (${cmd}). ${TOOL_SETUP_HINT}`
      };
    }
    return {
      ok: false,
      command: cmd,
      error: `${label} check failed (${cmd}): ${e?.message || e}`
    };
  }
}

/**
 * @returns {{ ok: boolean, hint: string, ytDlp: { ok: boolean, command: string, error?: string }, ffmpeg: { ok: boolean, command: string, error?: string } }}
 */
export function getToolSetupStatus() {
  const ytDlp = probeTool("yt-dlp", getYtDlpExecutable(), YTDLP_VERSION_ARGS);
  const ffmpeg = probeTool("ffmpeg", getFfmpegExecutable(), FFMPEG_VERSION_ARGS);
  return {
    ok: ytDlp.ok && ffmpeg.ok,
    hint: TOOL_SETUP_HINT,
    ytDlp,
    ffmpeg
  };
}

export function assertYtdlpAndFfmpegAvailable() {
  const ytDlp = probeTool("yt-dlp", getYtDlpExecutable(), YTDLP_VERSION_ARGS);
  if (!ytDlp.ok) {
    throw new Error(ytDlp.error);
  }
  const ffmpeg = probeTool("ffmpeg", getFfmpegExecutable(), FFMPEG_VERSION_ARGS);
  if (!ffmpeg.ok) {
    throw new Error(ffmpeg.error);
  }
}
