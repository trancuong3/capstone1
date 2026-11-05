import type {
  DeviceKind,
  DevicePermissionCheckResult,
  DevicePermissionSnapshotUI,
  DevicePermissionUiState,
  MicrophonePermissionUiState,
} from "@/types/reading";

export interface DevicePermissionService {
  getSnapshot(): Promise<DevicePermissionSnapshotUI>;
  getMicrophonePermissionState(): Promise<MicrophonePermissionUiState>;
  watchMicrophonePermissionState(
    onChange: (state: MicrophonePermissionUiState) => void,
  ): Promise<() => void>;
  requestAccess(kind: DeviceKind): Promise<DevicePermissionCheckResult>;
  /** Compatibility adapter for the existing in-session permission recovery UI. */
  retry(kind: DeviceKind): Promise<DevicePermissionUiState>;
}

function permissionStateToUiState(
  state: PermissionState | undefined,
): DevicePermissionUiState {
  if (state === "granted" || state === "denied" || state === "prompt") {
    return state;
  }
  return "unknown";
}

function isUnsupportedPermissionDescriptor(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TypeError" || error.name === "NotSupportedError")
  );
}

async function readBrowserPermission(
  kind: DeviceKind,
): Promise<DevicePermissionUiState> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unknown";
  }

  try {
    const descriptor: PermissionDescriptor = {
      name: kind as PermissionName,
    };
    const result = await navigator.permissions.query(descriptor);
    return permissionStateToUiState(result.state);
  } catch {
    return "unknown";
  }
}

function mapMicrophonePermissionState(
  state: PermissionState | undefined,
): MicrophonePermissionUiState {
  if (state === "granted" || state === "prompt" || state === "denied") {
    return state;
  }
  return "error";
}

async function queryMicrophonePermission(): Promise<{
  permissionStatus: PermissionStatus | null;
  state: MicrophonePermissionUiState;
}> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return { permissionStatus: null, state: "unsupported" };
  }

  try {
    const permissionStatus = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return {
      permissionStatus,
      state: mapMicrophonePermissionState(permissionStatus.state),
    };
  } catch (error) {
    return {
      permissionStatus: null,
      state: isUnsupportedPermissionDescriptor(error) ? "unsupported" : "error",
    };
  }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function classifyMediaError(
  error: unknown,
  kind: DeviceKind,
): Pick<DevicePermissionCheckResult, "status" | "verified" | "message"> {
  const name = error instanceof Error ? error.name : "";
  const deviceLabel = kind === "camera" ? "camera" : "microphone";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      status: "denied",
      verified: false,
      message:
        kind === "microphone"
          ? "Vui lòng cấp quyền microphone trong cài đặt trình duyệt."
          : "Vui lòng cấp quyền camera trong cài đặt trình duyệt.",
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      status: kind === "microphone" ? "no_device" : "unavailable",
      verified: false,
      message:
        kind === "microphone"
          ? "Không tìm thấy microphone trên thiết bị."
          : "Không tìm thấy camera trên thiết bị.",
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      status: kind === "microphone" ? "device_busy" : "error",
      verified: false,
      message:
        kind === "microphone"
          ? "Microphone đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại."
          : "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.",
    };
  }

  if (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError"
  ) {
    return {
      status: "error",
      verified: false,
      message: `Thiết bị ${deviceLabel} không đáp ứng cấu hình yêu cầu. Hãy thử lại hoặc chọn thiết bị khác.`,
    };
  }

  if (name === "SecurityError") {
    return {
      status: "error",
      verified: false,
      message:
        kind === "microphone"
          ? "Hãy sử dụng HTTPS hoặc localhost để truy cập microphone."
          : "Hãy sử dụng HTTPS hoặc localhost để truy cập camera.",
    };
  }

  return {
    status: "error",
    verified: false,
    message:
      kind === "microphone"
        ? "Không thể kiểm tra microphone. Hãy kiểm tra thiết bị và cài đặt trình duyệt rồi thử lại."
        : "Không thể kiểm tra camera. Hãy kiểm tra thiết bị và cài đặt trình duyệt rồi thử lại.",
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

    async getMicrophonePermissionState(): Promise<MicrophonePermissionUiState> {
      return (await queryMicrophonePermission()).state;
    },

    async watchMicrophonePermissionState(onChange) {
      const { permissionStatus, state } = await queryMicrophonePermission();
      onChange(state);
      if (!permissionStatus) return () => undefined;

      let active = true;
      const handleChange = () => {
        if (active)
          onChange(mapMicrophonePermissionState(permissionStatus.state));
      };
      if (typeof permissionStatus.addEventListener === "function") {
        permissionStatus.addEventListener("change", handleChange);
        return () => {
          active = false;
          permissionStatus.removeEventListener("change", handleChange);
        };
      }

      const previousOnChange = permissionStatus.onchange;
      permissionStatus.onchange = handleChange;
      return () => {
        active = false;
        if (permissionStatus.onchange === handleChange) {
          permissionStatus.onchange = previousOnChange;
        }
      };
    },

    async requestAccess(
      kind: DeviceKind,
    ): Promise<DevicePermissionCheckResult> {
      const mediaRecorderSupported = typeof MediaRecorder !== "undefined";
      if (typeof window === "undefined" || typeof navigator === "undefined") {
        return {
          status: "unsupported",
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
            kind === "microphone"
              ? "Hãy sử dụng HTTPS hoặc localhost để truy cập microphone."
              : "Hãy sử dụng HTTPS hoặc localhost để truy cập camera.",
          mediaRecorderSupported,
        };
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        return {
          status: "unsupported",
          verified: false,
          message:
            kind === "microphone"
              ? "Trình duyệt không hỗ trợ truy cập microphone. Hãy cập nhật hoặc đổi trình duyệt."
              : "Trình duyệt không hỗ trợ truy cập camera. Hãy cập nhật hoặc đổi trình duyệt.",
          mediaRecorderSupported,
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
        const tracks =
          kind === "camera" ? stream.getVideoTracks() : stream.getAudioTracks();
        const hasLiveTrack = tracks.some(
          (track) => track.readyState === "live",
        );
        if (!hasLiveTrack) {
          return {
            status: kind === "microphone" ? "no_device" : "unavailable",
            verified: false,
            message:
              kind === "microphone"
                ? "Không tìm thấy microphone đang hoạt động trên thiết bị."
                : "Không tìm thấy camera đang hoạt động trên thiết bị.",
            mediaRecorderSupported,
          };
        }

        if (kind === "microphone" && !mediaRecorderSupported) {
          return {
            status: "unsupported",
            verified: false,
            message:
              "Microphone đã được cấp quyền nhưng trình duyệt không hỗ trợ ghi âm cho buổi đọc. Hãy sử dụng trình duyệt mới hơn.",
            mediaRecorderSupported: false,
          };
        }

        return {
          status: "granted",
          verified: true,
          message:
            kind === "camera"
              ? "Camera đã được cấp quyền và thiết bị đang hoạt động."
              : "Microphone đã được cấp quyền và thiết bị đang hoạt động.",
          mediaRecorderSupported,
        };
      } catch (error) {
        return {
          ...classifyMediaError(error, kind),
          mediaRecorderSupported,
        };
      } finally {
        stopTracks(stream);
      }
    },

    async retry(kind: DeviceKind): Promise<DevicePermissionUiState> {
      const result = await this.requestAccess(kind);
      return result.verified ? "ready" : "denied";
    },
  };
}
