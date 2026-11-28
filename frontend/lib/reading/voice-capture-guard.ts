import type { AudioQualitySnapshot } from "@/lib/reading/audio-quality";
import { getVoicePolicyPreferences } from "@/lib/reading/session-voice-lock";
import {
  fetchVoiceEngineHealth,
  getVoiceEngineHealthForRouting,
  type VoiceEngineHealthSnapshot,
} from "@/lib/reading/voice-engine-status";

/**
 * Returns true when client-side WebAudio VAD / RMS analysis has measured actual
 * PCM frames and confirmed the recording is completely silent or empty (`rms` ~ 0).
 *
 * When `AudioContext` did not run (e.g. `status === "UNKNOWN"` with `durationMs === 0`),
 * returns `false` so headless/unit-test environments without WebAudio still transcribe.
 */
export function isConfirmedSilentVoiceCapture(
  quality: AudioQualitySnapshot | null | undefined,
): boolean {
  if (!quality) return false;
  if (quality.status === "NO_AUDIO" || quality.status === "SILENCE") {
    return true;
  }
  if (
    quality.status === "AUDIO_TOO_SHORT" &&
    quality.speechDurationMs === 0 &&
    quality.rms < 0.0005 &&
    quality.peak < 0.002
  ) {
    return true;
  }
  if (
    quality.durationMs > 0 &&
    quality.speechDurationMs === 0 &&
    quality.rms === 0 &&
    quality.peak === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Returns true ONLY when a fresh `/voice/status` snapshot is already cached and
 * confirms that zero server-side STT engines are available for the active policy
 * (e.g., local STT worker on `:8010` is stopped and cloud STT fallback is disabled
 * or unconfigured). Avoids firing a guaranteed-503 `POST /voice/speech-to-text`.
 */
export function isServerSttConfirmedUnavailable(
  healthOverride?: VoiceEngineHealthSnapshot | null,
): boolean {
  const health =
    healthOverride !== undefined
      ? healthOverride
      : getVoiceEngineHealthForRouting();
  if (!health) return false;

  const localSttReady = Boolean(
    health.local.available && health.local.stt_ready,
  );
  if (localSttReady) return false;

  const policy = getVoicePolicyPreferences();
  const googleAllowedAndReady = Boolean(
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleSttFallback &&
    health.google.stt_configured &&
    !health.google.stt_cooldown,
  );
  if (googleAllowedAndReady) return false;

  const elevenlabsReady = Boolean(
    policy.providerMode !== "local_only" &&
    health.elevenlabs?.stt_configured &&
    !health.elevenlabs?.stt_cooldown,
  );
  if (elevenlabsReady) return false;

  return true;
}

/**
 * Quietly refreshes `/voice/status` in the background after an unexpected STT
 * 503 failure so subsequent turns route directly to on-device fallback without
 * repeating failed network calls.
 */
export function refreshVoiceHealthQuietlyAfterSttFailure(): void {
  void fetchVoiceEngineHealth().catch(() => null);
}
