import type { ReadingReconnectDemoMode, ReadingUiState } from "@/types/reading";

const readingStates = new Set<ReadingUiState>([
  "ready",
  "reading",
  "camera-denied",
  "microphone-denied",
  "page-confidence-low",
  "manual-page",
  "paused",
  "reconnecting",
  "stt-error",
  "tts-error",
  "page-turn",
  "question",
  "complete",
]);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseReadingUiState(
  value: string | string[] | undefined,
): ReadingUiState {
  const candidate = firstValue(value);

  return candidate && readingStates.has(candidate as ReadingUiState)
    ? (candidate as ReadingUiState)
    : "ready";
}

export function parseReconnectDemoMode(
  value: string | string[] | undefined,
): ReadingReconnectDemoMode {
  return firstValue(value) === "timeout" ? "timeout" : "recover";
}

export function isEvidenceSuspended(state: ReadingUiState): boolean {
  return [
    "paused",
    "reconnecting",
    "stt-error",
    "camera-denied",
    "microphone-denied",
    "page-confidence-low",
    "page-turn",
  ].includes(state);
}
