#!/usr/bin/env node
/**
 * Downloads yt-dlp (release binary) and copies ffmpeg from ffmpeg-static into vendor/.
 * Run before electron:build. See electron-builder extraResources.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor");
fs.mkdirSync(vendor, { recursive: true });

const platform = process.platform;

let ytdlpUrl;
let ytdlpName;
if (platform === "darwin") {
  ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  ytdlpName = "yt-dlp";
} else if (platform === "win32") {
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
if (platform !== "win32") {
  fs.chmodSync(ytdlpPath, 0o755);
}

const { default: ffmpegPath } = await import("ffmpeg-static");
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  throw new Error("ffmpeg-static did not resolve a binary for this platform");
}
const ffName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const destFf = path.join(vendor, ffName);
fs.copyFileSync(ffmpegPath, destFf);
if (platform !== "win32") {
  fs.chmodSync(destFf, 0o755);
}

console.error("Wrote", ytdlpPath);
console.error("Wrote", destFf);
