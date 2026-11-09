import type { ComprehensionService } from "@/lib/api/comprehension-service";

/** Generation calls an AI model, so cap how long the finish button may wait. */
export const QUESTION_PREPARE_TIMEOUT_MS = 45_000;

/**
 * Decide what the child sees after a reading session is finished.
 *
 * The comprehension step is best effort: if the service is unavailable, times
 * out or produced no question, the child goes straight to the completion screen
 * and the finished session is never affected.
 */
export async function resolvePostFinishUiState(
  service: Pick<ComprehensionService, "prepareQuestions"> | undefined,
  sessionId: string,
  timeoutMs: number = QUESTION_PREPARE_TIMEOUT_MS,
): Promise<"question" | "complete"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof service?.prepareQuestions !== "function") return "complete";
    const total = await Promise.race([
      service.prepareQuestions(sessionId),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(0), timeoutMs);
      }),
    ]);
    return total > 0 ? "question" : "complete";
  } catch {
    return "complete";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
