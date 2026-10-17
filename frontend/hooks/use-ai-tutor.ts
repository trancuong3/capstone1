"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TutorService } from "@/lib/api/tutor-service";
import { isServiceError } from "@/lib/api/service-error";
import type {
  AiTutorState,
  TutorExplanationDTO,
  TutorWordSelection,
} from "@/types/tutor";

interface Snapshot {
  readonly key: string;
  readonly open: boolean;
  readonly state: AiTutorState;
}

function tutorError(
  error: unknown,
): Extract<AiTutorState, { status: "error" }> {
  const status = isServiceError(error) ? error.status : 0;
  if (status === 401)
    return {
      status: "error",
      message: "Ba mẹ vui lòng đăng nhập lại để sử dụng trợ giảng.",
      retryable: false,
    };
  if (status === 403)
    return {
      status: "error",
      message: "Tài khoản này chưa thể sử dụng trợ giảng cho buổi đọc.",
      retryable: false,
    };
  if (status === 404 || status === 409 || status === 422)
    return {
      status: "error",
      message: "Bé hãy chọn lại một từ trên trang đang đọc nhé.",
      retryable: false,
    };
  return {
    status: "error",
    message:
      "Mình chưa giải thích được lúc này. Bé có thể thử lại hoặc đọc tiếp nhé.",
    retryable: true,
  };
}

export function useAiTutor(
  service: TutorService,
  sessionId: string,
  selection: TutorWordSelection | null,
) {
  const key = JSON.stringify([
    sessionId,
    selection?.page_revision_id,
    selection?.word_id,
  ]);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    key,
    open: false,
    state: { status: "idle" },
  });
  const requestRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<{ key: string; result: TutorExplanationDTO } | null>(
    null,
  );

  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
      cacheRef.current = null;
    },
    [key, service],
  );

  const close = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setSnapshot((previous) => ({
      key,
      open: false,
      state: previous.key === key ? previous.state : { status: "idle" },
    }));
  }, [key]);

  const request = useCallback(async () => {
    if (!selection || requestRef.current) return;
    if (cacheRef.current?.key === key) {
      setSnapshot({
        key,
        open: true,
        state: { status: "ready", result: cacheRef.current.result },
      });
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setSnapshot({ key, open: true, state: { status: "loading" } });
    try {
      const result = await service.explainWord(
        sessionId,
        {
          page_revision_id: selection.page_revision_id,
          word_id: selection.word_id,
        },
        controller.signal,
      );
      if (controller.signal.aborted || requestRef.current !== controller)
        return;
      cacheRef.current = { key, result };
      setSnapshot({ key, open: true, state: { status: "ready", result } });
    } catch (error) {
      if (!controller.signal.aborted && requestRef.current === controller) {
        setSnapshot({ key, open: true, state: tutorError(error) });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [key, selection, service, sessionId]);

  const state: AiTutorState =
    snapshot.key === key ? snapshot.state : { status: "idle" };

  return {
    isOpen: snapshot.key === key && snapshot.open,
    state,
    request,
    close,
  };
}
