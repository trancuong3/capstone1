import type { SequentialReviewCandidate } from "@/lib/utils/sequential-reading-alignment";

export const MAX_REVIEW_ATTEMPTS = 2;


export type SessionReviewResolution =
  | "PENDING"
  | "REVIEWED_CORRECT"
  | "ASSISTED"
  | "UNRESOLVED";

export interface SessionReviewItem extends SequentialReviewCandidate {
  readonly reviewId: string;
  readonly pageOrder: number;
  readonly attempts: number;
  readonly resolution: SessionReviewResolution;
  readonly lastReviewConfidence?: number | null;
}

export interface SessionReviewQueueSnapshot {
  readonly items: readonly SessionReviewItem[];
  readonly pendingCount: number;
  readonly completedCount: number;
  readonly current: SessionReviewItem | null;
  readonly total: number;
}

export class SessionReviewQueue {
  private readonly itemsByOccurrence = new Map<string, SessionReviewItem>();

  addPageCandidates(
    candidates: readonly SequentialReviewCandidate[],
    pageOrder: number,
  ): void {
    for (const candidate of candidates) {
      // Identity is the source occurrence, never the displayed word string.
      const reviewId = [
        candidate.pageId,
        candidate.pageRevisionId,
        candidate.wordId,
      ].join(":");
      const previous = this.itemsByOccurrence.get(reviewId);
      if (previous) continue;
      this.itemsByOccurrence.set(reviewId, {
        ...candidate,
        reviewId,
        pageOrder,
        attempts: 0,
        resolution: "PENDING",
      });
    }
  }

  replacePageCandidates(
    candidates: readonly SequentialReviewCandidate[],
    pageOrder: number,
    pageId: string,
    pageRevisionId: string,
  ): void {
    const prefix = `${pageId}:${pageRevisionId}:`;
    for (const reviewId of this.itemsByOccurrence.keys()) {
      if (reviewId.startsWith(prefix)) {
        this.itemsByOccurrence.delete(reviewId);
      }
    }
    this.addPageCandidates(candidates, pageOrder);
  }

  getCurrent(): SessionReviewItem | null {
    return (
      this.sortedItems().find(
        (item) =>
          item.reason === "CONFIDENTLY_INCORRECT" &&
          item.resolution === "PENDING",
      ) ?? null
    );
  }

  recordAttempt(
    reviewId: string,
    result: "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_SPEECH",
    confidence: number | null = null,
  ): { accepted: boolean; needsAssistance: boolean; item: SessionReviewItem | null } {
    const current = this.getCurrent();
    if (!current || current.reviewId !== reviewId || current.attempts >= MAX_REVIEW_ATTEMPTS) {
      return { accepted: false, needsAssistance: false, item: current };
    }

    const attempts = current.attempts + 1;
    const resolution = result === "CORRECT" ? "REVIEWED_CORRECT" : "PENDING";
    const updated: SessionReviewItem = {
      ...current,
      attempts,
      resolution,
      lastReviewConfidence: confidence,
    };
    this.itemsByOccurrence.set(reviewId, updated);
    return {
      accepted: true,
      needsAssistance:
        result !== "CORRECT" && attempts >= MAX_REVIEW_ATTEMPTS,
      item: updated,
    };
  }

  markAssisted(reviewId: string): boolean {
    return this.resolveCurrent(reviewId, "ASSISTED", MAX_REVIEW_ATTEMPTS);
  }

  markUnresolved(reviewId: string): boolean {
    return this.resolveCurrent(reviewId, "UNRESOLVED", MAX_REVIEW_ATTEMPTS);
  }

  snapshot(): SessionReviewQueueSnapshot {
    // Keep all outcomes for history persistence, but expose only confirmed
    // pronunciation errors as child-facing end-review work.
    const items = this.sortedItems();
    const reviewItems = items.filter(
      (item) => item.reason === "CONFIDENTLY_INCORRECT",
    );
    const pending = reviewItems.filter(
      (item) => item.resolution === "PENDING",
    );
    return {
      items,
      pendingCount: pending.length,
      completedCount: reviewItems.length - pending.length,
      current: pending[0] ?? null,
      total: reviewItems.length,
    };
  }

  private resolveCurrent(
    reviewId: string,
    resolution: "ASSISTED" | "UNRESOLVED",
    minimumAttempts: number,
  ): boolean {
    const current = this.getCurrent();
    if (
      !current ||
      current.reviewId !== reviewId ||
      current.attempts < minimumAttempts
    ) {
      return false;
    }
    this.itemsByOccurrence.set(reviewId, { ...current, resolution });
    return true;
  }

  private sortedItems(): SessionReviewItem[] {
    return [...this.itemsByOccurrence.values()].sort(
      (left, right) =>
        left.pageOrder - right.pageOrder ||
        left.wordIndex - right.wordIndex ||
        left.wordId.localeCompare(right.wordId),
    );
  }
}
