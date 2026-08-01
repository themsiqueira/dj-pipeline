#!/usr/bin/env node
/**
 * Downloads yt-dlp (release binary) and ffmpeg into vendor/.
 * Run before electron:build. See electron-builder extraResources.
 *
 * Set VENDOR_ARCH to match the CPU arch of the packaged app (arm64 | x64 | ia32).
 * Defaults to process.arch. When it differs from the host (e.g. x64 app on Apple Silicon),
 * ffmpeg is downloaded from a pinned URL (macOS Intel) or GitHub (Windows).
 *
 * Set VENDOR_PLATFORM to the OS you are packaging for (win32 | darwin | linux) when it
 * differs from the host — e.g. electron:build:win sets VENDOR_PLATFORM=win32 so vendor/
 * gets yt-dlp.exe and ffmpeg.exe even if you run fetch-tools on macOS.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor");
fs.mkdirSync(vendor, { recursive: true });

const hostPlatform = process.platform;
const hostArch = normalizeArch(process.arch);
const vendorArch = normalizeArch(process.env.VENDOR_ARCH || process.arch);

function normalizePlatform(p) {
  const x = String(p || "").toLowerCase();
  if (x === "win32" || x === "windows") return "win32";
  if (x === "darwin" || x === "macos" || x === "osx") return "darwin";
  return x;
}

const vendorPlatform = normalizePlatform(process.env.VENDOR_PLATFORM || hostPlatform);

/** Pinned Intel macOS static build (zip contains `ffmpeg` at root). Redirects to CDN. */
const FFMPEG_DARWIN_X64_ZIP =
  process.env.FFMPEG_DARWIN_X64_URL ||
  "https://evermeet.cx/ffmpeg/ffmpeg-7.0.2.zip";
/** Optional: sha256 hex of the zip file after download (evermeet build). */
const FFMPEG_DARWIN_X64_SHA256 = process.env.FFMPEG_DARWIN_X64_SHA256 || "";

function normalizeArch(arch) {
  const a = String(arch || "").toLowerCase();
  if (a === "x64" || a === "x86_64" || a === "amd64") return "x64";
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "ia32" || a === "x32" || a === "i386") return "ia32";
  return a;
}

function canUseFfmpegStatic() {
  if (vendorPlatform !== hostPlatform) {
    return false;
  }
  if (hostPlatform === "win32" && vendorArch === "arm64") {
    return false;
  }
  return hostArch === vendorArch;
}

function sizeMb(filePath) {
  return (fs.statSync(filePath).size / 1e6).toFixed(1);
}

function sha256File(filePath) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function extractZip(zipPath, outDir) {
  execFileSync("tar", ["-xf", zipPath, "-C", outDir], { stdio: "inherit" });
}

/** Walk directory; return first file named `baseName` (case-insensitive on win). */
function findBinary(dir, baseName) {
  const want = baseName.toLowerCase();
  function walk(d) {
    for (const ent of fs.readdirSync(d)) {
      const p = path.join(d, ent);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const f = walk(p);
        if (f) return f;
      } else if (ent.toLowerCase() === want) {
        return p;
      }
    }
    return null;
  }
  return walk(dir);
}

async function downloadToFile(url, destPath) {
  console.error("Fetching:", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

/**
 * Prefers the LGPL build over GPL. Verified to still carry libmp3lame, libopus and
 * libvorbis — the GPL-only additions (x264/x265) are video encoders this pipeline
 * never invokes. It is also ~109 MB rather than ~136 MB, and every megabyte is
 * on-access antivirus scanning on the user's first run.
 *
 * @param {"win64" | "winarm64"} flavour
 * @param {string} envVar name of the URL override for the error message
 */
async function fetchBtbNWindowsZip(flavour, envVar) {
  const override = process.env[envVar]?.trim();
  if (override) {
    return override;
  }

  const r = await fetch("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest");
  if (!r.ok) {
    throw new Error(`BtbN FFmpeg-Builds releases/latest failed: HTTP ${r.status}`);
  }
  const assets = (await r.json()).assets || [];

  const matches = (a, license, pinned) =>
    a.name.endsWith(".zip") &&
    !a.name.includes("shared") &&
    a.name.includes(flavour) &&
    (flavour === "win64" ? !a.name.includes("winarm64") : true) &&
    a.name.includes(license) &&
    (!pinned || a.name.includes("7.1"));

  const pick =
    assets.find((a) => matches(a, "lgpl", true)) ||
    assets.find((a) => matches(a, "lgpl", false)) ||
    assets.find((a) => matches(a, "gpl", true)) ||
    assets.find((a) => matches(a, "gpl", false));

  if (!pick) {
    throw new Error(
      `No ${flavour} zip in BtbN FFmpeg-Builds latest release. Set ${envVar}.`
    );
  }
  return pick.browser_download_url;
}

async function installFfmpeg() {
  const ffName = vendorPlatform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const destFf = path.join(vendor, ffName);

  if (canUseFfmpegStatic()) {
    const { default: ffmpegPath } = await import("ffmpeg-static");
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      throw new Error("ffmpeg-static did not resolve a binary for this platform");
    }
    fs.copyFileSync(ffmpegPath, destFf);
    if (vendorPlatform !== "win32") {
      fs.chmodSync(destFf, 0o755);
    }
    console.error("Wrote", destFf, "(ffmpeg-static)");
    return;
  }

  if (
    vendorPlatform === "darwin" &&
    hostPlatform === "darwin" &&
    vendorArch === "x64" &&
    hostArch === "arm64"
  ) {
    const tmpRoot = fs.mkdtempSync(path.join(path.dirname(vendor), "ffmpeg-fetch-"));
    const zipPath = path.join(tmpRoot, "ffmpeg.zip");
    try {
      await downloadToFile(FFMPEG_DARWIN_X64_ZIP, zipPath);
      if (FFMPEG_DARWIN_X64_SHA256) {
        const got = sha256File(zipPath);
        if (got !== FFMPEG_DARWIN_X64_SHA256.toLowerCase()) {
          throw new Error(
            `ffmpeg zip SHA256 mismatch (got ${got}). Update FFMPEG_DARWIN_X64_SHA256 or URL.`
          );
        }
      }
      const extractDir = path.join(tmpRoot, "out");
      fs.mkdirSync(extractDir, { recursive: true });
      extractZip(zipPath, extractDir);
      const found = findBinary(extractDir, "ffmpeg");
      if (!found) {
        throw new Error("ffmpeg binary not found inside Intel macOS zip");
      }
      fs.copyFileSync(found, destFf);
      fs.chmodSync(destFf, 0o755);
      console.error("Wrote", destFf, "(Intel macOS static zip)");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    return;
  }

  if (vendorPlatform === "win32" && vendorArch === "arm64") {
    const tmpRoot = fs.mkdtempSync(path.join(path.dirname(vendor), "ffmpeg-fetch-"));
    const zipPath = path.join(tmpRoot, "ffmpeg.zip");
    try {
      const url = await fetchBtbNWindowsZip("winarm64", "FFMPEG_WIN_ARM64_URL");
      await downloadToFile(url, zipPath);
      const extractDir = path.join(tmpRoot, "out");
      fs.mkdirSync(extractDir, { recursive: true });
      extractZip(zipPath, extractDir);
      const found = findBinary(extractDir, "ffmpeg.exe");
      if (!found) {
        throw new Error("ffmpeg.exe not found inside Windows ARM64 zip");
      }
      fs.copyFileSync(found, destFf);
      console.error("Wrote", destFf, `(Windows ARM64 BtbN, ${sizeMb(destFf)} MB)`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    return;
  }

  if (vendorPlatform === "win32" && vendorArch === "x64" && !canUseFfmpegStatic()) {
    const tmpRoot = fs.mkdtempSync(path.join(path.dirname(vendor), "ffmpeg-fetch-"));
    const zipPath = path.join(tmpRoot, "ffmpeg.zip");
    try {
      const url = await fetchBtbNWindowsZip("win64", "FFMPEG_WIN_X64_URL");
      await downloadToFile(url, zipPath);
      const extractDir = path.join(tmpRoot, "out");
      fs.mkdirSync(extractDir, { recursive: true });
      extractZip(zipPath, extractDir);
      const found = findBinary(extractDir, "ffmpeg.exe");
      if (!found) {
        throw new Error("ffmpeg.exe not found inside Windows x64 zip");
      }
      fs.copyFileSync(found, destFf);
      console.error("Wrote", destFf, `(Windows x64 BtbN, ${sizeMb(destFf)} MB)`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    return;
  }

  throw new Error(
    `Unsupported vendor ffmpeg fetch: host ${hostPlatform}/${hostArch}, ` +
      `target ${vendorPlatform}/${vendorArch}. ` +
      `Build on a machine whose arch matches VENDOR_ARCH, or extend scripts/fetch-native-tools.mjs. ` +
      `Note: Apple Silicon .app with x64 Electron needs VENDOR_ARCH=x64 on an arm64 Mac (Intel ffmpeg zip).`
  );
}

function tryRun(cmd, args, label) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (err) {
    console.error(`  (skipped ${label}: ${String(err?.message || err).split("\n")[0]})`);
    return false;
  }
}

/**
 * Trims what can be trimmed from the macOS yt-dlp binary's per-exec cost.
 *
 * Measured on arm64: `--version` went from ~10.2 s to ~9.8 s, and 38.26 MB to
 * 37.94 MB. Thinning barely helps because the fat file is mostly a *shared*
 * PyInstaller payload rather than two full code slices, so the ~10 s is dominated by
 * re-extracting the Python runtime on every invocation and cannot be fixed here.
 * Stripping com.apple.quarantine is still worth doing: it removes Gatekeeper's
 * first-launch assessment on the end user's machine, which this local measurement
 * (already assessed) does not capture.
 *
 * The real fix was to stop invoking yt-dlp three times per track; see
 * downloadTrackBundle. Shipping the zipapp instead of the PyInstaller build would
 * remove the remainder, but it needs a Python runtime on the target machine.
 */
function optimizeDarwinBinary(binPath) {
  if (vendorPlatform !== "darwin" || hostPlatform !== "darwin") return;

  tryRun("xattr", ["-d", "com.apple.quarantine", binPath], "quarantine strip");

  // Thinning invalidates the signature, so it has to be re-signed ad-hoc afterwards.
  const thinned = `${binPath}.thin`;
  if (tryRun("lipo", [binPath, "-thin", vendorArch, "-output", thinned], `lipo -thin ${vendorArch}`)) {
    try {
      fs.renameSync(thinned, binPath);
      fs.chmodSync(binPath, 0o755);
    } catch (err) {
      console.error(`  (thin rename failed: ${err.message})`);
      fs.rmSync(thinned, { force: true });
    }
  } else {
    fs.rmSync(thinned, { force: true });
  }

  tryRun("codesign", ["--force", "--sign", "-", binPath], "ad-hoc codesign");
}

async function fetchYtDlp() {
  let ytdlpUrl;
  let ytdlpName;
  if (vendorPlatform === "darwin") {
    ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    ytdlpName = "yt-dlp";
  } else if (vendorPlatform === "win32") {
    ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    ytdlpName = "yt-dlp.exe";
  } else {
    ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
    ytdlpName = "yt-dlp";
  }

  console.error("Fetching yt-dlp:", ytdlpUrl);
  const res = await fetch(ytdlpUrl);
  if (!res.ok) {
    throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
  }
  const ytdlpPath = path.join(vendor, ytdlpName);
  fs.writeFileSync(ytdlpPath, Buffer.from(await res.arrayBuffer()));
  if (vendorPlatform !== "win32") {
    fs.chmodSync(ytdlpPath, 0o755);
  }
  optimizeDarwinBinary(ytdlpPath);
  console.error("Wrote", ytdlpPath, `(${(fs.statSync(ytdlpPath).size / 1e6).toFixed(1)} MB)`);
}

console.error(`Vendor target: ${vendorPlatform}/${vendorArch} (host ${hostPlatform}/${hostArch})`);

await fetchYtDlp();
await installFfmpeg();
