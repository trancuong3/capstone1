import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import { LocalSegmentSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";

describe("LocalSegmentSpeechRecognition service-outage circuit breaker", () => {
  it("trips immediately on STT 503 outage, cleans up without loop, and emits stt-unavailable", async () => {
    const transcribe = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "STT_UNAVAILABLE",
        message: "Voice worker offline",
        status: 503,
        request_id: "req-503",
        retryable: true,
      }),
    );
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-1", pageId: "page-1", keyterms: ["Mèo"] }),
    );
    const errors: Array<{ error?: string }> = [];
    let ended = false;
    rec.onerror = (ev) => errors.push(ev);
    rec.onend = () => {
      ended = true;
    };

    (rec as unknown as { active: boolean; abortController: AbortController }).active = true;
    (rec as unknown as { abortController: AbortController }).abortController = new AbortController();
    (rec as unknown as { speechChunks: Float32Array[]; speechSamples: number; inSpeech: boolean }).speechChunks = [
      new Float32Array(3200),
    ];
    (rec as unknown as { speechSamples: number }).speechSamples = 3200;
    (rec as unknown as { inSpeech: boolean }).inSpeech = true;

    const internal = rec as unknown as {
      flushCurrentSegment: (carry?: boolean) => void;
    };
    internal.flushCurrentSegment(false);
    await new Promise((r) => setTimeout(r, 30));

    // Must not retry on 503 or accept further segments once circuit opens.
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([{ error: "stt-unavailable" }]);
    expect(ended).toBe(false);

    (rec as unknown as { speechChunks: Float32Array[]; speechSamples: number }).speechChunks = [
      new Float32Array(3200),
    ];
    (rec as unknown as { speechSamples: number }).speechSamples = 3200;
    internal.flushCurrentSegment(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
