import type {
  ReadingConnectionState,
  ReadingControlAction,
  ReadingRealtimeSnapshotUI,
  ReadingReconnectDemoMode,
  ReadingSessionState,
  ReadingUiState,
} from "@/types/reading";

export type ReadingSocketUnsubscribe = () => void;

export interface ReadingSocketAdapter {
  subscribe(
    sessionId: string,
    onState: (state: ReadingSessionState) => void,
  ): ReadingSocketUnsubscribe;
  sendControl(
    sessionId: string,
    action: ReadingControlAction,
  ): Promise<ReadingSessionState>;
  reconnect(
    sessionId: string,
    mode: ReadingReconnectDemoMode,
  ): Promise<ReadingConnectionState>;
  getSafetySnapshot(state: ReadingUiState): ReadingRealtimeSnapshotUI;
}

export function createReadingSocketAdapter(): ReadingSocketAdapter {
  return {
    subscribe(): ReadingSocketUnsubscribe {
      return () => {};
    },

    async sendControl(
      _sessionId: string,
      action: ReadingControlAction,
    ): Promise<ReadingSessionState> {
      if (action === "start" || action === "resume") {
        return "LISTENING";
      }
      if (action === "pause") {
        return "PAUSED";
      }
      if (action === "finish") {
        return "FINISHED";
      }
      return "ABORTED";
    },

    async reconnect(): Promise<ReadingConnectionState> {
      return "recovered";
    },

    getSafetySnapshot(): ReadingRealtimeSnapshotUI {
      return {
        connection: "connected",
        scoring_active: true,
        evidence_valid: true,
        child_error_events: [],
      };
    },
  };
}
