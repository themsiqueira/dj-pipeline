import fs from "fs";
import path from "path";

function csvEscape(field) {
  const s = String(field ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * @param {string} outDir
 * @param {{ message: string, code: string, at: string }} detail
 * @returns {string} written file path
 */
export function writeLastRunErrorArtifact(outDir, { message, code, at }) {
  const filePath = path.join(outDir, "last_run_error.txt");
  const body = [`at: ${at}`, `code: ${code}`, "", message].join("\n");
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}

/**
 * @param {string} filePath
 * @param {{ index: number, url: string, title: string, reason: string }[]} rows
 * @param {{ playlistTitle?: string, playlistUrl?: string, exportedAt?: string }} [meta]
 * @returns {string} filePath
 */
export function writeFailureReportCsv(filePath, rows, meta = {}) {
  const playlistTitle = meta.playlistTitle ?? "";
  const playlistUrl = meta.playlistUrl ?? "";
  const exportedAt = meta.exportedAt ?? new Date().toISOString();
  const lines = ["index,url,title,reason,playlist_title,playlist_url,exported_at"];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.index),
        csvEscape(r.url),
        csvEscape(r.title),
        csvEscape(r.reason),
        csvEscape(playlistTitle),
        csvEscape(playlistUrl),
        csvEscape(exportedAt)
      ].join(",")
    );
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}
