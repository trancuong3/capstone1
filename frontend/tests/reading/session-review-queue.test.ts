import { describe, expect, it } from "vitest";

import {
  MAX_REVIEW_ATTEMPTS,
  SessionReviewQueue,
} from "@/lib/utils/session-review-queue";
import type { SequentialReviewCandidate } from "@/lib/utils/sequential-reading-alignment";

function candidate(
  pageId: string,
  wordId: string,
  wordIndex: number,
  expectedWord = "khỏe",
  reason: SequentialReviewCandidate["reason"] = "CONFIDENTLY_INCORRECT",
): SequentialReviewCandidate {
  return {
    pageId,
    pageRevisionId: `revision-${pageId}`,
    wordId,
    wordIndex,
    expectedWord,
    recognizedWord: "khỏ",
    logprob: -0.1,
    confidence: Math.exp(-0.1),
    occurredAtMs: 1_000,
    reason,
  };
}

describe("SessionReviewQueue", () => {
  it("keeps duplicate displayed words as separate token occurrences", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([
      candidate("page-1", "line-a-khoe", 1),
      candidate("page-1", "line-b-khoe", 3),
    ], 0);

    expect(queue.snapshot().total).toBe(2);
    expect(queue.getCurrent()?.wordId).toBe("line-a-khoe");
    expect(queue.snapshot().items.map((item) => item.expectedWord)).toEqual([
      "khỏe",
      "khỏe",
    ]);
  });

  it("preserves page range order and word position rather than insertion order", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([
      candidate("page-2", "p2-word-0", 0, "mèo"),
    ], 1);
    queue.addPageCandidates([
      candidate("page-1", "p1-word-3", 3, "nhỏ"),
      candidate("page-1", "p1-word-1", 1, "Bé"),
    ], 0);

    expect(queue.snapshot().items.map((item) => item.wordId)).toEqual([
      "p1-word-1",
      "p1-word-3",
      "p2-word-0",
    ]);
  });

  it("does not create a review item for a correctly read word", () => {
    const queue = new SessionReviewQueue();
    // The caller only adds tracker review candidates; a correct token therefore
    // has no candidate and cannot be synthesized here.
    queue.addPageCandidates([], 0);
    expect(queue.snapshot().total).toBe(0);
    expect(queue.getCurrent()).toBeNull();
  });

  it("moves to the next exact occurrence after a correct review attempt", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([
      candidate("page-1", "wrong-1", 0, "Hôm"),
      candidate("page-1", "wrong-2", 1, "nay"),
    ], 0);
    const first = queue.getCurrent();
    expect(first).not.toBeNull();

    const result = queue.recordAttempt(first!.reviewId, "CORRECT");

    expect(result.accepted).toBe(true);
    expect(result.item?.resolution).toBe("REVIEWED_CORRECT");
    expect(queue.getCurrent()?.wordId).toBe("wrong-2");
  });

  it("allows one more attempt after the first incorrect attempt", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([candidate("page-1", "wrong-1", 0)], 0);
    const item = queue.getCurrent()!;

    const first = queue.recordAttempt(item.reviewId, "INCORRECT");
    expect(first.accepted).toBe(true);
    expect(first.needsAssistance).toBe(false);
    expect(queue.getCurrent()?.attempts).toBe(1);

    const second = queue.recordAttempt(item.reviewId, "INCORRECT");
    expect(second.accepted).toBe(true);
    expect(second.needsAssistance).toBe(true);
    expect(second.item?.attempts).toBe(MAX_REVIEW_ATTEMPTS);
  });

  it("does not allow a third attempt after two unsuccessful attempts", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([candidate("page-1", "wrong-1", 0)], 0);
    const item = queue.getCurrent()!;
    queue.recordAttempt(item.reviewId, "NO_SPEECH");
    queue.recordAttempt(item.reviewId, "UNCERTAIN");

    const third = queue.recordAttempt(item.reviewId, "CORRECT");
    expect(third.accepted).toBe(false);
    expect(third.item?.attempts).toBe(2);
    expect(queue.markAssisted(item.reviewId)).toBe(true);
    expect(queue.getCurrent()).toBeNull();
  });

  it("rejects a delayed callback when the queue has already moved to another token", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([
      candidate("page-1", "old-item", 0),
      candidate("page-1", "new-item", 1),
    ], 0);
    const oldItem = queue.getCurrent()!;
    queue.recordAttempt(oldItem.reviewId, "CORRECT");

    const stale = queue.recordAttempt(oldItem.reviewId, "INCORRECT");
    expect(stale.accepted).toBe(false);
    expect(queue.getCurrent()?.wordId).toBe("new-item");
  });

  it("keeps no-speech and uncertain separate from confirmed mispronunciation", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([
      candidate("page-1", "silent", 0, "Con", "NO_SPEECH"),
      candidate("page-1", "uncertain", 1, "mèo", "UNCERTAIN"),
    ], 0);

    expect(queue.snapshot().items.map((item) => item.reason)).toEqual([
      "NO_SPEECH",
      "UNCERTAIN",
    ]);
    expect(queue.snapshot().items.every((item) => item.resolution === "PENDING")).toBe(true);
  });

  it("retains uncertain and no-speech outcomes for history without adding them to child review", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates(
      [
        candidate("page-1", "uncertain", 0, "khỏe", "UNCERTAIN"),
        candidate("page-1", "silent", 1, "mèo", "NO_SPEECH"),
      ],
      0,
    );

    const snapshot = queue.snapshot();
    expect(snapshot.items.map((item) => item.reason)).toEqual([
      "UNCERTAIN",
      "NO_SPEECH",
    ]);
    expect(snapshot.current).toBeNull();
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.total).toBe(0);
  });

  it("records model pronunciation as assisted, not independently correct", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([candidate("page-1", "assisted", 0)], 0);
    const item = queue.getCurrent()!;
    queue.recordAttempt(item.reviewId, "INCORRECT");
    queue.recordAttempt(item.reviewId, "INCORRECT");

    expect(queue.markAssisted(item.reviewId)).toBe(true);
    expect(queue.snapshot().items[0].resolution).toBe("ASSISTED");
    expect(queue.snapshot().items[0].resolution).not.toBe("REVIEWED_CORRECT");
  });

  it("aggregates candidates from multiple pages and waits for the session-end consumer", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates([candidate("page-1", "p1-wrong", 2)], 0);
    expect(queue.snapshot().pendingCount).toBe(1);
    queue.addPageCandidates([candidate("page-2", "p2-wrong", 1)], 1);

    expect(queue.snapshot().items.map((item) => item.wordId)).toEqual([
      "p1-wrong",
      "p2-wrong",
    ]);
    expect(queue.snapshot().pendingCount).toBe(2);
  });
  it("replaces prior review candidates when the child revisits and rereads the same page", () => {
    const queue = new SessionReviewQueue();
    queue.addPageCandidates(
      [candidate("page-1", "first-pass-error", 1, "mèo")],
      0,
    );
    expect(queue.snapshot().total).toBe(1);

    // A later pass on the same verified revision has no incorrect tokens.
    queue.replacePageCandidates(
      [],
      0,
      "page-1",
      "revision-page-1",
    );

    expect(queue.snapshot().total).toBe(0);
    expect(queue.getCurrent()).toBeNull();
  });

});
