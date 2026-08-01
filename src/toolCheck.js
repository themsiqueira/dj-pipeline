import fs from "fs";
import path from "path";
import { getYtDlpExecutable, getFfmpegExecutable } from "./binaries.js";
import { pipelineError, PIPELINE_ERROR } from "./pipelineErrors.js";

export const TOOL_SETUP_HINT =
  "Install yt-dlp and ffmpeg on your PATH, or set env vars YOUTUBE_DJ_YTDLP and YOUTUBE_DJ_FFMPEG to full paths to the executables (names use DJ then YTDLP / FFMPEG). " +
  "For the desktop app, run npm run fetch-tools on the target OS (Windows needs vendor/yt-dlp.exe and vendor/ffmpeg.exe) then rebuild so resources/vendor is bundled in the installer.";

function looksLikeFilesystemPath(cmd) {
  if (path.isAbsolute(cmd)) {
    return true;
  }
  return cmd.includes(path.sep) || /^[A-Za-z]:[\\/]/.test(cmd);
}

async function isExecutableFile(p) {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return false;
    await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name against PATH. A handful of stat calls, versus the
 * ~11 s a `--version` launch of the PyInstaller yt-dlp bundle costs.
 * @param {string} cmd
 * @returns {Promise<string | null>}
 */
async function resolveOnPath(cmd) {
  const dirs = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const exts =
    process.platform === "win32"
      ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const suffix = ext && cmd.toLowerCase().endsWith(ext.toLowerCase()) ? "" : ext;
      const candidate = path.join(dir, `${cmd}${suffix}`);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** @type {Map<string, { sig: string, result: { ok: boolean, command: string, error?: string } }>} */
const probeCache = new Map();

export function clearToolProbeCache() {
  probeCache.clear();
}

/**
 * Answers "is this tool present and executable", not "what version is it".
 * Running `--version` to decide that costs ~11 s for yt-dlp on every call; a broken
 * but present binary is reported by the first real invocation instead, which
 * `toPipelineError` already maps to TOOLS_UNAVAILABLE.
 * @param {string} label
 * @param {string} cmd
 * @returns {Promise<{ ok: boolean, command: string, error?: string }>}
 */
export async function probeTool(label, cmd) {
  const pathLike = looksLikeFilesystemPath(cmd);
  const resolved = pathLike ? path.resolve(cmd) : await resolveOnPath(cmd);

  const missing = pathLike
    ? { ok: false, command: cmd, error: `${label} not found at "${cmd}". ${TOOL_SETUP_HINT}` }
    : {
        ok: false,
        command: cmd,
        error: `${label} is not installed or not reachable (${cmd}). ${TOOL_SETUP_HINT}`
      };

  if (!resolved) {
    return missing;
  }

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return missing;
  }
  if (!stat.isFile()) {
    return missing;
  }

  const sig = `${resolved}\u0000${stat.size}\u0000${stat.mtimeMs}`;
  const cached = probeCache.get(cmd);
  if (cached && cached.sig === sig) {
    return cached.result;
  }

  const result = (await isExecutableFile(resolved))
    ? { ok: true, command: cmd }
    : {
        ok: false,
        command: cmd,
        error: `${label} check failed (${cmd}): file exists but is not executable. ${TOOL_SETUP_HINT}`
      };

  probeCache.set(cmd, { sig, result });
  return result;
}

/**
 * @returns {Promise<{ ok: boolean, hint: string, ytDlp: { ok: boolean, command: string, error?: string }, ffmpeg: { ok: boolean, command: string, error?: string } }>}
 */
export async function getToolSetupStatus() {
  const [ytDlp, ffmpeg] = await Promise.all([
    probeTool("yt-dlp", getYtDlpExecutable()),
    probeTool("ffmpeg", getFfmpegExecutable())
  ]);
  return {
    ok: ytDlp.ok && ffmpeg.ok,
    hint: TOOL_SETUP_HINT,
    ytDlp,
    ffmpeg
  };
}

export async function assertYtdlpAndFfmpegAvailable() {
  const status = await getToolSetupStatus();
  if (!status.ytDlp.ok) {
    throw pipelineError(PIPELINE_ERROR.TOOLS_UNAVAILABLE, status.ytDlp.error);
  }
  if (!status.ffmpeg.ok) {
    throw pipelineError(PIPELINE_ERROR.TOOLS_UNAVAILABLE, status.ffmpeg.error);
  }
}

/**
 * Analysing a local library downloads nothing, so a missing yt-dlp is no reason
 * to refuse the run.
 */
export async function assertFfmpegAvailable() {
  const ffmpeg = await probeTool("ffmpeg", getFfmpegExecutable());
  if (!ffmpeg.ok) {
    throw pipelineError(PIPELINE_ERROR.TOOLS_UNAVAILABLE, ffmpeg.error);
  }
}
