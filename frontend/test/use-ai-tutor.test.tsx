// Isolated request-lifecycle tests; no live tutor requests.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAiTutor } from "@/hooks/use-ai-tutor";
import { ServiceError } from "@/lib/api/service-error";
import { createTutorService, type TutorService } from "@/lib/api/tutor-service";
import type { TutorExplanationDTO } from "@/types/tutor";

const sessionId = "77777777-7777-4777-8777-777777777777";
const selection = {
  page_revision_id: "55555555-5555-4555-8555-555555555555",
  word_id: "66666666-6666-4666-8666-666666666666",
  word: "nghiêng",
};
const explanation = {
  ...selection,
  explanation: "Lệch sang một bên.",
  reading_hint: "Bé đọc lại câu nhé.",
};

function fixture() {
  const explainWord = vi
    .fn<TutorService["explainWord"]>()
    .mockResolvedValue(explanation);
  return { service: { ...createTutorService(), explainWord }, explainWord };
}

function deferred() {
  let resolve: (value: TutorExplanationDTO) => void = () => undefined;
  const promise = new Promise<TutorExplanationDTO>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("AI tutor request lifecycle", () => {
  it("does not auto-request, and reopening the same result uses memory", async () => {
    const { service, explainWord } = fixture();
    const { result } = renderHook(() =>
      useAiTutor(service, sessionId, selection),
    );
    expect(explainWord).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.state).toEqual({
      status: "ready",
      result: explanation,
    });
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    await act(async () => {
      await result.current.request();
    });
    expect(explainWord).toHaveBeenCalledOnce();
    expect(result.current.isOpen).toBe(true);
  });

  it("deduplicates requests and ignores a late response after closing", async () => {
    const { service, explainWord } = fixture();
    const pending = deferred();
    explainWord.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() =>
      useAiTutor(service, sessionId, selection),
    );
    act(() => {
      void result.current.request();
      void result.current.request();
    });
    expect(explainWord).toHaveBeenCalledOnce();
    const signal = explainWord.mock.calls[0][2];
    act(() => result.current.close());
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(explanation));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.state.status).not.toBe("ready");
  });

  it("aborts and hides the previous result on revision changes", async () => {
    const { service, explainWord } = fixture();
    const pending = deferred();
    explainWord.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ selected }) => useAiTutor(service, sessionId, selected),
      { initialProps: { selected: selection } },
    );
    act(() => {
      void result.current.request();
    });
    const signal = explainWord.mock.calls[0][2];
    rerender({
      selected: {
        ...selection,
        page_revision_id: "88888888-8888-4888-8888-888888888888",
      },
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(explanation));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.state.status).toBe("idle");
  });

  it("cancels on unmount even if the service does not honor AbortSignal", async () => {
    const { service, explainWord } = fixture();
    const pending = deferred();
    explainWord.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() =>
      useAiTutor(service, sessionId, selection),
    );
    act(() => {
      void result.current.request();
    });
    const signal = explainWord.mock.calls[0][2];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(explanation));
  });

  it("keeps authentication and stale selection errors non-retryable and hides raw text", async () => {
    for (const status of [401, 403, 404, 409, 422]) {
      const { service, explainWord } = fixture();
      explainWord.mockRejectedValueOnce(
        new ServiceError({
          status,
          code: "NETWORK_ERROR",
          message: "private upstream details",
          request_id: "",
          retryable: true,
        }),
      );
      const { result, unmount } = renderHook(() =>
        useAiTutor(service, sessionId, selection),
      );
      await act(async () => {
        await result.current.request();
      });
      expect(result.current.state).toMatchObject({
        status: "error",
        retryable: false,
      });
      expect(JSON.stringify(result.current.state)).not.toContain("private");
      unmount();
    }
  });

  it("offers retry for provider failure and accepts the later successful result", async () => {
    const { service, explainWord } = fixture();
    explainWord.mockRejectedValueOnce(new Error("private diagnostics"));
    const { result } = renderHook(() =>
      useAiTutor(service, sessionId, selection),
    );
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.state).toMatchObject({
      status: "error",
      retryable: true,
    });
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.state).toEqual({
      status: "ready",
      result: explanation,
    });
  });
});
