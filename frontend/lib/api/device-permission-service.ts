import type {
  DeviceKind,
  DevicePermissionSnapshotUI,
  DevicePermissionUiState,
} from "@/types/reading";

export interface DevicePermissionService {
  getSnapshot(): Promise<DevicePermissionSnapshotUI>;
  retry(kind: DeviceKind): Promise<DevicePermissionUiState>;
}

export function createDevicePermissionService(): DevicePermissionService {
  return {
    async getSnapshot(): Promise<DevicePermissionSnapshotUI> {
      return {
        camera: "ready",
        microphone: "ready",
      };
    },

    async retry(_kind: DeviceKind): Promise<DevicePermissionUiState> {
      return "ready";
    },
  };
}
