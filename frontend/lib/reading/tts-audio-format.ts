export type TtsAudioFormat = "wav" | "mp3" | "ogg";

function probeCanPlay(mimeType: string): boolean {
  if (typeof document === "undefined") return true;
  try {
    const audio = document.createElement("audio");
    if (typeof audio.canPlayType !== "function") return true;
    const hasCodecSupport =
      Boolean(audio.canPlayType("audio/mpeg")) ||
      Boolean(audio.canPlayType("audio/wav")) ||
      Boolean(audio.canPlayType('audio/ogg; codecs="opus"'));
    // In headless/jsdom environments where HTMLMediaElement.canPlayType returns ""
    // for every codec, still advertise audio/mpeg with audio/wav fallback.
    if (!hasCodecSupport) return mimeType === "audio/mpeg";
    return Boolean(audio.canPlayType(mimeType));
  } catch {
    return true;
  }
}

/**
 * Builds an HTTP `Accept` header preferring compressed MP3/OGG audio for low
 * egress while always keeping `audio/wav` as a lossless fallback.
 */
export function getPreferredTtsAcceptHeader(
  explicitFormat?: TtsAudioFormat,
): string {
  if (explicitFormat === "wav") return "audio/wav";
  if (explicitFormat === "mp3") return "audio/mpeg, audio/wav;q=0.8";
  if (explicitFormat === "ogg") return "audio/ogg, audio/wav;q=0.8";

  const parts: string[] = [];
  if (probeCanPlay("audio/mpeg")) parts.push("audio/mpeg;q=1.0");
  if (probeCanPlay('audio/ogg; codecs="opus"')) parts.push("audio/ogg;q=0.9");
  parts.push("audio/wav;q=0.8", "audio/*;q=0.5");
  return parts.join(", ");
}

/**
 * Builds an HTTP `Accept` header for JSON endpoints that embed base64 audio
 * (`audio_base64` + `content_type`), advertising preferred audio MIME types.
 */
export function getPreferredJsonTtsAcceptHeader(
  explicitFormat?: TtsAudioFormat,
): string {
  if (explicitFormat === "wav") {
    return "application/json, audio/wav;q=1.0";
  }
  if (explicitFormat === "mp3") {
    return "application/json, audio/mpeg;q=1.0, audio/wav;q=0.8";
  }
  if (explicitFormat === "ogg") {
    return "application/json, audio/ogg;q=1.0, audio/wav;q=0.8";
  }
  return `application/json, ${getPreferredTtsAcceptHeader()}`;
}

export function isWavAudioBlob(blob: Blob): boolean {
  const normalized = blob.type.trim().toLowerCase();
  return (
    normalized === "audio/wav" ||
    normalized === "audio/x-wav" ||
    normalized === "audio/wave" ||
    normalized === "audio/vnd.wave"
  );
}
