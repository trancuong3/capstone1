import type { DevicePermissionService } from "@/lib/api/device-permission-service";
import { waitForReadingMock } from "@/lib/mock/mock-reading-data";

export function createMockDevicePermissionService(): DevicePermissionService {
  return {
    async getSnapshot() {
      await waitForReadingMock(120);
      return { camera: "ready", microphone: "ready" };
    },

    async retry() {
      await waitForReadingMock();
      return "ready";
    },
  };
}
