import fs from "fs";
import os from "os";
import path from "path";

/**
 * The one settings file, shared by the desktop app and the CLI.
 *
 * The directory name predates the rename to DJ Pipeline and stays as it is: it
 * already holds people's Spotify credentials, and moving it would silently log
 * them out to buy nothing but a tidier path.
 *
 * Environment variables always win over this file. A shell that exports a key is
 * making a deliberate, temporary choice, and the file is the persistent default.
 */

export function userConfigPath() {
  return path.join(os.homedir(), ".youtube-dj", "config.json");
}

/** @returns {Record<string, unknown>} an empty object when absent or unreadable */
export function readUserConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(userConfigPath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge values into one top-level section, leaving the others alone — the app
 * must never drop Spotify credentials while saving an AI key.
 *
 * @param {string} section
 * @param {Record<string, unknown>} values keys with an empty value are removed
 */
export function writeUserConfigSection(section, values) {
  const config = readUserConfig();
  const existing = config[section] && typeof config[section] === "object" ? config[section] : {};
  const merged = { ...existing };

  for (const [key, value] of Object.entries(values)) {
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "" || text === null || text === undefined) {
      delete merged[key];
    } else {
      merged[key] = text;
    }
  }

  if (Object.keys(merged).length > 0) {
    config[section] = merged;
  } else {
    delete config[section];
  }

  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // The file holds API keys, so it is not readable by other accounts on the
  // machine. Written to a temp name first so a crash mid-write cannot truncate
  // credentials that were already there.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows has no POSIX mode; the rename still applied the content */
  }

  return config[section] ?? {};
}
