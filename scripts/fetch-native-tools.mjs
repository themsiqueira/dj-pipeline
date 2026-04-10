#!/usr/bin/env node
/**
 * Downloads yt-dlp (release binary) and ffmpeg into vendor/.
 * Run before electron:build. See electron-builder extraResources.
 *
 * Set VENDOR_ARCH to match the CPU arch of the packaged app (arm64 | x64 | ia32).
 * Defaults to process.arch. When it differs from the host (e.g. x64 app on Apple Silicon),
 * ffmpeg is downloaded from a pinned URL (macOS Intel) or GitHub (Windows ARM64).
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
  if (hostPlatform === "win32" && vendorArch === "arm64") {
    return false;
  }
  return hostArch === vendorArch;
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

async function fetchBtbNWinArm64GplZip() {
  const override = process.env.FFMPEG_WIN_ARM64_URL?.trim();
  if (override) {
    return override;
  }
  const r = await fetch("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest");
  if (!r.ok) {
    throw new Error(`BtbN FFmpeg-Builds releases/latest failed: HTTP ${r.status}`);
  }
  const j = await r.json();
  const assets = j.assets || [];
  const pick =
    assets.find(
      (a) =>
        a.name.endsWith(".zip") &&
        !a.name.includes("shared") &&
        a.name.includes("winarm64") &&
        a.name.includes("gpl") &&
        a.name.includes("7.1")
    ) ||
    assets.find(
      (a) =>
        a.name.endsWith(".zip") &&
        !a.name.includes("shared") &&
        a.name.includes("winarm64") &&
        a.name.includes("gpl")
    );
  if (!pick) {
    throw new Error(
      "No winarm64 GPL zip in BtbN FFmpeg-Builds latest release. Set FFMPEG_WIN_ARM64_URL."
    );
  }
  return pick.browser_download_url;
}

async function installFfmpeg() {
  const ffName = hostPlatform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const destFf = path.join(vendor, ffName);

  if (canUseFfmpegStatic()) {
    const { default: ffmpegPath } = await import("ffmpeg-static");
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      throw new Error("ffmpeg-static did not resolve a binary for this platform");
    }
    fs.copyFileSync(ffmpegPath, destFf);
    if (hostPlatform !== "win32") {
      fs.chmodSync(destFf, 0o755);
    }
    console.error("Wrote", destFf, "(ffmpeg-static)");
    return;
  }

  if (hostPlatform === "darwin" && vendorArch === "x64" && hostArch === "arm64") {
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

  if (hostPlatform === "win32" && vendorArch === "arm64") {
    const tmpRoot = fs.mkdtempSync(path.join(path.dirname(vendor), "ffmpeg-fetch-"));
    const zipPath = path.join(tmpRoot, "ffmpeg.zip");
    try {
      const url = await fetchBtbNWinArm64GplZip();
      await downloadToFile(url, zipPath);
      const extractDir = path.join(tmpRoot, "out");
      fs.mkdirSync(extractDir, { recursive: true });
      extractZip(zipPath, extractDir);
      const found = findBinary(extractDir, "ffmpeg.exe");
      if (!found) {
        throw new Error("ffmpeg.exe not found inside Windows ARM64 zip");
      }
      fs.copyFileSync(found, destFf);
      console.error("Wrote", destFf, "(Windows ARM64 BtbN build)");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    return;
  }

  throw new Error(
    `Unsupported vendor ffmpeg fetch: host ${hostPlatform}/${hostArch}, ` +
      `target ${hostPlatform}/${vendorArch}. ` +
      `Build on a machine whose arch matches VENDOR_ARCH, or extend scripts/fetch-native-tools.mjs. ` +
      `Note: Apple Silicon .app with x64 Electron needs VENDOR_ARCH=x64 on an arm64 Mac (Intel ffmpeg zip).`
  );
}

async function fetchYtDlp() {
  let ytdlpUrl;
  let ytdlpName;
  if (hostPlatform === "darwin") {
    ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    ytdlpName = "yt-dlp";
  } else if (hostPlatform === "win32") {
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
  if (hostPlatform !== "win32") {
    fs.chmodSync(ytdlpPath, 0o755);
  }
  console.error("Wrote", ytdlpPath);
}

console.error(`Vendor arch: ${vendorArch} (host ${hostPlatform}/${hostArch})`);

await fetchYtDlp();
await installFfmpeg();
