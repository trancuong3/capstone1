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
    subscribe(_sessionId: string, _onState: (state: ReadingSessionState) => void): ReadingSocketUnsubscribe {
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

    async reconnect(
      _sessionId: string,
      _mode: ReadingReconnectDemoMode,
    ): Promise<ReadingConnectionState> {
      return "recovered";
    },

    getSafetySnapshot(_state: ReadingUiState): ReadingRealtimeSnapshotUI {
      return {
        connection: "connected",
        scoring_active: true,
        evidence_valid: true,
        child_error_events: [],
      };
    },
  };
}
