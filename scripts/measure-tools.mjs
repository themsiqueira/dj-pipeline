#!/usr/bin/env node
/**
 * Times the vendored binaries' startup cost. Run this on Windows to check the
 * Defender hypothesis:
 *
 *   node scripts/measure-tools.mjs                        # baseline
 *   Add-MpPreference -ExclusionPath (Resolve-Path vendor)  # elevated PowerShell
 *   node scripts/measure-tools.mjs                        # compare
 *
 * The first run of each binary is reported separately because it is the one that
 * pays for the on-access antivirus scan and the page cache miss.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor");
const win = process.platform === "win32";

const targets = [
  { name: win ? "yt-dlp.exe" : "yt-dlp", args: ["--version"] },
  { name: win ? "ffmpeg.exe" : "ffmpeg", args: ["-version"] }
];

function timeOnce(bin, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(Date.now() - started));
  });
}

const RUNS = 4;

for (const { name, args } of targets) {
  const bin = path.join(vendor, name);
  if (!fs.existsSync(bin)) {
    console.log(`${name}: not present in vendor/ (run npm run fetch-tools)`);
    continue;
  }

  const sizeMb = (fs.statSync(bin).size / 1e6).toFixed(1);
  const timings = [];
  for (let i = 0; i < RUNS; i++) {
    timings.push(await timeOnce(bin, args));
  }

  if (timings.some((t) => t === null)) {
    console.log(`${name}: failed to execute`);
    continue;
  }

  const [first, ...rest] = timings;
  const warm = rest.reduce((a, b) => a + b, 0) / rest.length;
  console.log(
    `${name.padEnd(12)} ${sizeMb.padStart(6)} MB   first ${String(first).padStart(6)} ms   ` +
      `warm avg ${warm.toFixed(0).padStart(6)} ms   (${timings.join(", ")} ms)`
  );
}
