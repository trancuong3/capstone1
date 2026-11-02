/**
 * Per-word STT confidence is supplied by ElevenLabs Scribe v2 as logprob.
 * The app has no calibrated speech-confidence cutoff today. Until the product
 * sets NEXT_PUBLIC_READING_WORD_CONFIDENCE_THRESHOLD (0..1), results stay
 * UNCERTAIN rather than being marked CORRECT or CONFIDENTLY_INCORRECT.
 */
export function getReadingWordConfidenceThreshold(): number | null {
  const configured = process.env.NEXT_PUBLIC_READING_WORD_CONFIDENCE_THRESHOLD;
  if (!configured?.trim()) return null;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}
