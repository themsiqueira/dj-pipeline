export const AUDIO_FORMAT = { MP3: "mp3", FLAC: "flac" };

export const DEFAULT_AUDIO_FORMAT = AUDIO_FORMAT.MP3;

/**
 * Never throws: unknown/missing values fall back to MP3 so a bad UI or CLI value
 * degrades to the historical behaviour instead of failing the run.
 * @param {unknown} value
 * @returns {"mp3" | "flac"}
 */
export function normalizeAudioFormat(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === AUDIO_FORMAT.FLAC ? AUDIO_FORMAT.FLAC : DEFAULT_AUDIO_FORMAT;
}
