/**
 * Proxy configuration shared by every yt-dlp launch. A regional block is decided by
 * the IP the request comes from, so routing yt-dlp through a proxy is the only real
 * workaround (yt-dlp's header-level `--xff` bypass does nothing for SoundCloud).
 */
import { pipelineError, PIPELINE_ERROR } from "./pipelineErrors.js";

/** Schemes yt-dlp itself understands for `--proxy`. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

/**
 * @returns {string} the configured proxy, or "" when unset
 * @throws when set but unusable, so a typo fails before the first download rather
 *   than silently downloading without the proxy the user asked for
 */
export function resolveProxy() {
  const raw = process.env.YOUTUBE_DJ_PROXY?.trim();
  if (!raw) return "";

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw pipelineError(
      PIPELINE_ERROR.INVALID_URL,
      `Invalid pipeline URL: YOUTUBE_DJ_PROXY is not a URL (${raw}). ` +
        "Use a form like socks5://127.0.0.1:1080 or http://host:3128."
    );
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw pipelineError(
      PIPELINE_ERROR.INVALID_URL,
      `Invalid pipeline URL: unsupported proxy scheme "${url.protocol.replace(":", "")}". ` +
        `Use one of: ${[...ALLOWED_SCHEMES].map((s) => s.replace(":", "")).join(", ")}.`
    );
  }
  if (!url.hostname) {
    throw pipelineError(
      PIPELINE_ERROR.INVALID_URL,
      `Invalid pipeline URL: proxy is missing a host (${raw}).`
    );
  }
  return raw;
}

/**
 * Extra yt-dlp CLI tokens every invocation needs, whatever the source site.
 * @returns {string[]}
 */
export function sourceNetworkArgs() {
  const proxy = resolveProxy();
  return proxy ? ["--proxy", proxy] : [];
}

/**
 * A proxy URL may carry credentials, and run logs are pasted into bug reports.
 * @param {string} proxy
 * @returns {string}
 */
export function redactProxyForLog(proxy) {
  const s = String(proxy || "").trim();
  if (!s) return "";
  try {
    const url = new URL(s);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "(set)";
  }
}
