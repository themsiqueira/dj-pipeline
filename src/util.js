import fs from "fs";
import path from "path";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Size in bytes, or 0 when the file is unreadable. */
export function fileSizeQuiet(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function join(...parts) {
  return path.join(...parts);
}

/** Best-effort removal; never throws. */
export async function removeQuiet(target) {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Delete everything inside `dir` but keep the directory. Used to stop scratch files
 * from a failed or cancelled run accumulating across runs.
 */
export async function emptyDirQuiet(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(entries.map((name) => removeQuiet(path.join(dir, name))));
}

