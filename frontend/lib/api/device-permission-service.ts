import type {
  DeviceKind,
  DevicePermissionCheckResult,
  DevicePermissionSnapshotUI,
  DevicePermissionUiState,
} from "@/types/reading";

export interface DevicePermissionService {
  getSnapshot(): Promise<DevicePermissionSnapshotUI>;
  requestAccess(kind: DeviceKind): Promise<DevicePermissionCheckResult>;
  /** Compatibility adapter for the existing in-session permission recovery UI. */
  retry(kind: DeviceKind): Promise<DevicePermissionUiState>;
}

const VERIFICATION_TTL_MS = 3 * 60 * 1000;
let verifiedUntil = 0;

/**
 * This short-lived, tab-memory ticket prevents a direct URL visit from opening
 * the scanner without completing the permission preflight. It is deliberately
 * not persisted to localStorage/sessionStorage and is consumed once.
 */
export function markDevicePermissionVerified(): void {
  verifiedUntil = Date.now() + VERIFICATION_TTL_MS;
}

export function clearDevicePermissionVerification(): void {
  verifiedUntil = 0;
}

export function consumeDevicePermissionVerification(): boolean {
  const isValid = verifiedUntil > Date.now();
  verifiedUntil = 0;
  return isValid;
}

function permissionStateToUiState(
  state: PermissionState | undefined,
): DevicePermissionUiState {
  if (state === "granted" || state === "denied" || state === "prompt") {
    return state;
  }
  return "unknown";
}

async function readBrowserPermission(
  kind: DeviceKind,
): Promise<DevicePermissionUiState> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unknown";
  }

  try {
    // Camera/microphone descriptors are not implemented consistently. A
    // rejected or unsupported descriptor is an unknown state, never a grant.
    const descriptor: PermissionDescriptor = {
      name: kind as PermissionName,
    };
    const result = await navigator.permissions.query(descriptor);
    return permissionStateToUiState(result.state);
  } catch {
    return "unknown";
  }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function classifyMediaError(
  error: unknown,
): Pick<DevicePermissionCheckResult, "status" | "verified" | "message"> {
  const name = error instanceof Error ? error.name : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      status: "denied",
      verified: false,
      message:
        "Quyền truy cập đã bị từ chối. Ba mẹ hãy cho phép thiết bị trong cài đặt website rồi thử lại.",
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      status: "unavailable",
      verified: false,
      message: "Không tìm thấy thiết bị này trên máy tính hoặc điện thoại.",
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      status: "error",
      verified: false,
      message:
        "Thiết bị đang bận hoặc không thể khởi động. Ba mẹ hãy đóng ứng dụng khác đang sử dụng thiết bị rồi thử lại.",
    };
  }

  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      status: "error",
      verified: false,
      message:
        "Thiết bị không đáp ứng được cấu hình yêu cầu. Hãy thử lại hoặc chọn thiết bị khác.",
    };
  }

  if (name === "SecurityError") {
    return {
      status: "error",
      verified: false,
      message:
        "Trình duyệt đang chặn quyền truy cập thiết bị vì lý do bảo mật hoặc chính sách website.",
    };
  }

  return {
    status: "error",
    verified: false,
    message:
      "Không thể truy cập thiết bị. Ba mẹ hãy kiểm tra kết nối và cài đặt trình duyệt rồi thử lại.",
  };
}

export function createDevicePermissionService(): DevicePermissionService {
  return {
    async getSnapshot(): Promise<DevicePermissionSnapshotUI> {
      if (typeof window === "undefined" || typeof navigator === "undefined") {
        return {
          camera: "unknown",
          microphone: "unknown",
          mediaDevicesSupported: false,
          mediaRecorderSupported: false,
          secureContext: false,
        };
      }

      const secureContext = window.isSecureContext;
      const mediaDevicesSupported = Boolean(
        navigator.mediaDevices?.getUserMedia,
      );
      const mediaRecorderSupported = typeof MediaRecorder !== "undefined";

      if (!secureContext || !mediaDevicesSupported) {
        const unsupportedState: DevicePermissionUiState = secureContext
          ? "unavailable"
          : "error";
        return {
          camera: unsupportedState,
          microphone: unsupportedState,
          mediaDevicesSupported,
          mediaRecorderSupported,
          secureContext,
        };
      }

      const [camera, microphone] = await Promise.all([
        readBrowserPermission("camera"),
        readBrowserPermission("microphone"),
      ]);

      return {
        camera,
        microphone,
        mediaDevicesSupported,
        mediaRecorderSupported,
        secureContext,
      };
    },

    async requestAccess(
      kind: DeviceKind,
    ): Promise<DevicePermissionCheckResult> {
      if (typeof window === "undefined" || typeof navigator === "undefined") {
        return {
          status: "unknown",
          verified: false,
          message: "Quyền thiết bị chỉ có thể được kiểm tra trong trình duyệt.",
          mediaRecorderSupported: false,
        };
      }

      if (!window.isSecureContext) {
        return {
          status: "error",
          verified: false,
          message:
            "Camera và microphone chỉ hoạt động trên HTTPS hoặc localhost. Hãy mở ViRead bằng kết nối bảo mật.",
          mediaRecorderSupported: typeof MediaRecorder !== "undefined",
        };
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        return {
          status: "unavailable",
          verified: false,
          message:
            "Trình duyệt này không hỗ trợ truy cập camera và microphone. Hãy cập nhật hoặc đổi trình duyệt.",
          mediaRecorderSupported: typeof MediaRecorder !== "undefined",
        };
      }

      let stream: MediaStream | null = null;
      try {
        const constraints: MediaStreamConstraints =
          kind === "camera"
            ? {
                video: {
                  facingMode: { ideal: "environment" },
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                },
                audio: false,
              }
            : { audio: true, video: false };

        stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track =
          kind === "camera"
            ? stream.getVideoTracks()[0]
            : stream.getAudioTracks()[0];

        if (!track || track.readyState !== "live") {
          return {
            status: "unavailable",
            verified: false,
            message: "Không thể khởi động thiết bị. Ba mẹ hãy kiểm tra lại thiết bị.",
            mediaRecorderSupported: typeof MediaRecorder !== "undefined",
          };
        }

        const mediaRecorderSupported = typeof MediaRecorder !== "undefined";
        if (kind === "microphone" && !mediaRecorderSupported) {
          return {
            status: "granted",
            verified: false,
            message:
              "Microphone đã được cấp quyền nhưng trình duyệt không hỗ trợ MediaRecorder cần cho buổi đọc. Hãy sử dụng trình duyệt mới hơn.",
            mediaRecorderSupported: false,
          };
        }

        return {
          status: "granted",
          verified: true,
          message:
            kind === "camera"
              ? "Camera đã được cấp quyền và thiết bị đang hoạt động."
              : "Microphone đã được cấp quyền và thiết bị ghi âm sẵn sàng.",
          mediaRecorderSupported,
        };
      } catch (error) {
        return {
          ...classifyMediaError(error),
          mediaRecorderSupported: typeof MediaRecorder !== "undefined",
        };
      } finally {
        // Permission verification must never leave an unused device active.
        stopTracks(stream);
      }
    },

    async retry(kind: DeviceKind): Promise<DevicePermissionUiState> {
      const result = await this.requestAccess(kind);
      return result.verified ? "ready" : "denied";
    },
  };
}
