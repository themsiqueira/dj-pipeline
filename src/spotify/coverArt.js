import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { ensureDir } from "../util.js";

/**
 * Download a Spotify album art image to disk.
 * @param {string} url
 * @param {string} outputPath
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | null>}
 */
export async function downloadSpotifyCoverArt(url, outputPath, signal) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  ensureDir(path.dirname(outputPath));

  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("Cancelled");
    return null;
  }
  if (!res.ok || !res.body) return null;

  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outputPath));
  } catch (err) {
    if (err?.message === "Cancelled" || signal?.aborted) throw new Error("Cancelled");
    return null;
  }
  return outputPath;
}
