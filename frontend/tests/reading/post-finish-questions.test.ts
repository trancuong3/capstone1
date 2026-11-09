import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePostFinishUiState } from "@/lib/reading/post-finish-questions";

afterEach(() => vi.useRealTimers());

describe("resolvePostFinishUiState", () => {
  it("shows the questions when the tutor produced at least one", async () => {
    const prepareQuestions = vi.fn().mockResolvedValue(3);
    await expect(
      resolvePostFinishUiState({ prepareQuestions }, "session-1"),
    ).resolves.toBe("question");
    expect(prepareQuestions).toHaveBeenCalledWith("session-1");
  });

  it("goes straight to completion when there is nothing to ask", async () => {
    await expect(
      resolvePostFinishUiState(
        { prepareQuestions: vi.fn().mockResolvedValue(0) },
        "session-1",
      ),
    ).resolves.toBe("complete");
  });

  it("never blocks completion when the service is missing, throws or fails", async () => {
    await expect(resolvePostFinishUiState(undefined, "s")).resolves.toBe(
      "complete",
    );
    await expect(resolvePostFinishUiState({}, "s")).resolves.toBe("complete");
    await expect(
      resolvePostFinishUiState(
        {
          prepareQuestions: () => {
            throw new Error("not implemented");
          },
        },
        "s",
      ),
    ).resolves.toBe("complete");
    await expect(
      resolvePostFinishUiState(
        { prepareQuestions: vi.fn().mockRejectedValue(new Error("boom")) },
        "s",
      ),
    ).resolves.toBe("complete");
  });

  it("stops waiting for a slow model after the timeout", async () => {
    vi.useFakeTimers();
    const pending = resolvePostFinishUiState(
      { prepareQuestions: () => new Promise<number>(() => undefined) },
      "s",
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe("complete");
  });
});
