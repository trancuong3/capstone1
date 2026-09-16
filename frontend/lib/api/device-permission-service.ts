import type {
  DeviceKind,
  DevicePermissionSnapshotUI,
  DevicePermissionUiState,
} from "@/types/reading";

export interface DevicePermissionService {
  getSnapshot(): Promise<DevicePermissionSnapshotUI>;
  retry(kind: DeviceKind): Promise<DevicePermissionUiState>;
}
