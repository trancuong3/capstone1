import type { SpeechTranscript } from "@/lib/api/speech-service";
import {
  hasUnusableAudio,
  type AudioQualitySnapshot,
} from "@/lib/reading/audio-quality";
import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";

/** Conservative rejection gates, not calibrated pronunciation probabilities.
 * Language probability describes language identification only. Word logprob
 * describes ASR uncertainty, not whether a child pronounced a word correctly.
 */
export function hasUsableTranscript(
  transcript: SpeechTranscript,
  quality?: AudioQualitySnapshot,
): boolean {
  if (
    hasUnusableAudio(quality) ||
    !tokenizeVietnameseText(transcript.text).length
  )
    return false;
  if (
    transcript.language_code &&
    !["vi", "vie", "vi-VN"].includes(transcript.language_code)
  )
    return false;
  const words =
    transcript.words?.filter((word) => !word.type || word.type === "word") ??
    [];
  if (transcript.words?.length && !words.length) return false;
  return !words.some(
    (word) =>
      word.logprob != null &&
      (!Number.isFinite(word.logprob) || word.logprob < -1.5),
  );
}

export function hasUsableBrowserConfidence(confidence?: number): boolean {
  // Some engines report zero when confidence is not supplied.
  return (
    confidence === undefined ||
    confidence === 0 ||
    (Number.isFinite(confidence) && confidence >= 0.5 && confidence <= 1)
  );
}
