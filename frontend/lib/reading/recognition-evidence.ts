import type { SpeechTranscript } from "@/lib/api/speech-service";
import {
  hasUnusableAudio,
  type AudioQualitySnapshot,
} from "@/lib/reading/audio-quality";
import { matchPhonicsSpelling } from "@/lib/reading/phonics-spelling";
import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";
import { normalizeShortWordTranscript } from "@/lib/reading/retry-word-recognition";

export function isConfidentExactBrowserRead(
  target: string,
  text?: string | null,
  confidence?: number | null,
): boolean {
  if (
    !text ||
    confidence == null ||
    confidence < 0.9 ||
    confidence > 1 ||
    !Number.isFinite(confidence)
  )
    return false;
  const expected = normalizeShortWordTranscript(target);
  return Boolean(expected && normalizeShortWordTranscript(text) === expected);
}

/**
 * True when the browser recognizer captured a complete Grade-1 phonics
 * spelling-out sequence ending in the exact target word (e.g. "ê tờ ê tê")
 * with usable phonics confidence (`>= 0.30` or unspecified `0`).
 */
export function isConfidentPhonicsBrowserRead(
  target: string,
  text?: string | null,
  confidence?: number | null,
): boolean {
  if (!text) return false;
  if (
    confidence != null &&
    confidence !== 0 &&
    (!Number.isFinite(confidence) || confidence < 0.3 || confidence > 1)
  ) {
    return false;
  }
  const expected = normalizeShortWordTranscript(target);
  if (!expected || /\s/u.test(expected)) return false;
  const tokens = tokenizeVietnameseText(text);
  if (tokens.length < 2) return false;
  const match = matchPhonicsSpelling(tokens, expected);
  return Boolean(match && match.consumedCount === tokens.length);
}

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

/**
 * Returns true when a keyterm-biased transcription has high enough word-level
 * confidence to be trusted without independent browser corroboration.
 *
 * The threshold (logprob >= −0.5) is intentionally much stricter than the
 * general usability gate (−1.5) to guard against keyterm hallucination while
 * still accepting clear correct pronunciations that the browser missed.
 */
export function hasHighConfidenceKeytermResult(
  transcript: SpeechTranscript,
): boolean {
  const words =
    transcript.words?.filter((word) => !word.type || word.type === "word") ??
    [];
  // Require at least one word with a logprob score to make a judgement.
  if (!words.length || !words.some((w) => w.logprob != null)) return false;
  return words.every(
    (word) =>
      word.logprob == null ||
      (Number.isFinite(word.logprob) && word.logprob >= -0.5),
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

/**
 * Controlled lower confidence floor (`>= 0.28`) used EXCLUSIVELY when the
 * spoken tokens match legal Grade-1 phonics cues for the active target word.
 * Web Speech API (`vi-VN`) frequently scores isolated vowel/consonant names
 * ("ê", "tờ", "ô") between `0.28` and `0.49`.
 */
export function hasUsablePhonicsBrowserConfidence(
  confidence?: number,
): boolean {
  return (
    confidence === undefined ||
    confidence === 0 ||
    (Number.isFinite(confidence) && confidence >= 0.28 && confidence <= 1)
  );
}

/**
 * Controlled lower confidence floor (`>= 0.28`) for children's single/short
 * Vietnamese syllables on Chrome Web Speech API when the recognized token(s)
 * match words within the child's immediate reading window (`[cursor - 1 .. cursor + 2]`).
 * Never alters `hasUsableBrowserConfidence` or injects text into STT.
 */
export function hasUsableChildWindowBrowserConfidence(
  spokenText: string,
  windowWords: readonly string[],
  confidence?: number,
): boolean {
  if (!hasUsablePhonicsBrowserConfidence(confidence)) return false;
  const spoken = tokenizeVietnameseText(spokenText);
  if (spoken.length === 0 || spoken.length > 3) return false;
  const allowed = new Set<string>();
  for (const w of windowWords) {
    for (const tok of tokenizeVietnameseText(w)) {
      allowed.add(tok);
    }
  }
  if (allowed.size === 0) return false;
  return spoken.every((tok) => allowed.has(tok));
}
