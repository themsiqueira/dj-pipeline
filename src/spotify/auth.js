import { loadSpotifyCredentials } from "./credentials.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

let cached = /** @type {{ token: string, expiresAt: number } | null} */ (null);

export function clearTokenCache() {
  cached = null;
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function getSpotifyAccessToken(signal) {
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const { clientId, clientSecret } = loadSpotifyCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials",
      signal
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("Cancelled");
    throw new Error(`Spotify API error: token request failed: ${err?.message || err}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Spotify API error: token ${res.status} ${res.statusText}: ${body}`);
  }

  const data = await res.json();
  const token = data?.access_token;
  const expiresIn = Number(data?.expires_in) || 3600;
  if (typeof token !== "string" || !token) {
    throw new Error("Spotify API error: token response missing access_token");
  }
  cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}
