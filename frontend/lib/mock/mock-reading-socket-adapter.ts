import type { ReadingSocketAdapter } from "@/lib/api/reading-socket-adapter";
import { isEvidenceSuspended } from "@/lib/utils/reading-state";
import { waitForReadingMock } from "@/lib/mock/mock-reading-data";

export function createMockReadingSocketAdapter(): ReadingSocketAdapter {
  return {
    subscribe(_sessionId, onState) {
      const timer = globalThis.setTimeout(() => onState("PAGE_READY"), 0);
      return () => globalThis.clearTimeout(timer);
    },

    async sendControl(_sessionId, action) {
      await waitForReadingMock(180);
      const states = {
        start: "LISTENING",
        pause: "PAUSED",
        resume: "LISTENING",
        finish: "FINISHED",
        abort: "ABORTED",
      } as const;
      return states[action];
    },

    async reconnect(_sessionId, mode) {
      await waitForReadingMock(360);
      return mode === "timeout" ? "timed-out" : "recovered";
    },

    getSafetySnapshot(state) {
      const suspended = isEvidenceSuspended(state);
      return {
        connection:
          state === "reconnecting" || state === "stt-error"
            ? "reconnecting"
            : "connected",
        scoring_active: state === "reading" && !suspended,
        evidence_valid: state === "reading" && !suspended,
        child_error_events: [],
      };
    },
  };
}
