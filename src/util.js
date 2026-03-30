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

export function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function join(...parts) {
  return path.join(...parts);
}

