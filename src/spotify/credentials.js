import fs from "fs";
import os from "os";
import path from "path";
import { PIPELINE_ERROR } from "../pipelineErrors.js";

export const SPOTIFY_CREDENTIALS_HELP =
  "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables, " +
  "or create ~/.youtube-dj/config.json with " +
  '{"spotify":{"clientId":"...","clientSecret":"..."}}. ' +
  "Get credentials at https://developer.spotify.com/dashboard.";

export class SpotifyCredentialsMissingError extends Error {
  constructor() {
    super(`Spotify credentials missing: ${SPOTIFY_CREDENTIALS_HELP}`);
    this.name = "SpotifyCredentialsMissingError";
    this.code = PIPELINE_ERROR.SPOTIFY_CREDENTIALS_MISSING;
  }
}

/**
 * @returns {{ clientId: string, clientSecret: string }}
 */
export function loadSpotifyCredentials() {
  const envId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const envSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  const configPath = path.join(os.homedir(), ".youtube-dj", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      const sp = parsed?.spotify;
      const id = typeof sp?.clientId === "string" ? sp.clientId.trim() : "";
      const secret = typeof sp?.clientSecret === "string" ? sp.clientSecret.trim() : "";
      if (id && secret) {
        return { clientId: id, clientSecret: secret };
      }
    } catch {
      /* fall through to error */
    }
  }

  throw new SpotifyCredentialsMissingError();
}
