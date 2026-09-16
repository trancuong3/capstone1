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
