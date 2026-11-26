import type {
  DeviceKind,
  DevicePermissionCheckResult,
  DevicePermissionSnapshotUI,
  DevicePermissionUiState,
  MicrophonePermissionUiState,
} from "@/types/reading";
import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary, TranslationParams } from "@/lib/i18n/types";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

function resolveRuntimeLocale(): SupportedLocale {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

function tPermError(key: string, params?: TranslationParams): string {
  const locale = resolveRuntimeLocale();
  const activeMessages: MessagesDictionary =
    getCachedLocaleMessages(locale) ?? viMessages;
  return translateMessage(activeMessages, viMessages, locale, key, params);
}

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
  const deviceLabel = tPermError(
    kind === "camera"
      ? "errors.devicePermission.deviceCamera"
      : "errors.devicePermission.deviceMicrophone",
  );

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      status: "denied",
      verified: false,
      message: tPermError(
        kind === "microphone"
          ? "errors.devicePermission.deniedMic"
          : "errors.devicePermission.deniedCamera",
      ),
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      status: kind === "microphone" ? "no_device" : "unavailable",
      verified: false,
      message: tPermError(
        kind === "microphone"
          ? "errors.devicePermission.notFoundMic"
          : "errors.devicePermission.notFoundCamera",
      ),
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      status: kind === "microphone" ? "device_busy" : "error",
      verified: false,
      message: tPermError(
        kind === "microphone"
          ? "errors.devicePermission.busyMic"
          : "errors.devicePermission.busyCamera",
      ),
    };
  }

  if (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError"
  ) {
    return {
      status: "error",
      verified: false,
      message: tPermError("errors.devicePermission.overconstrained", {
        device: deviceLabel,
      }),
    };
  }

  if (name === "SecurityError") {
    return {
      status: "error",
      verified: false,
      message: tPermError(
        kind === "microphone"
          ? "errors.devicePermission.insecureMic"
          : "errors.devicePermission.insecureCamera",
      ),
    };
  }

  return {
    status: "error",
    verified: false,
    message: tPermError(
      kind === "microphone"
        ? "errors.devicePermission.genericMic"
        : "errors.devicePermission.genericCamera",
    ),
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
          message: tPermError("errors.devicePermission.browserOnly"),
          mediaRecorderSupported: false,
        };
      }

      if (!window.isSecureContext) {
        return {
          status: "error",
          verified: false,
          message: tPermError(
            kind === "microphone"
              ? "errors.devicePermission.insecureMic"
              : "errors.devicePermission.insecureCamera",
          ),
          mediaRecorderSupported,
        };
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        return {
          status: "unsupported",
          verified: false,
          message: tPermError(
            kind === "microphone"
              ? "errors.devicePermission.unsupportedMic"
              : "errors.devicePermission.unsupportedCamera",
          ),
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
            message: tPermError(
              kind === "microphone"
                ? "errors.devicePermission.noLiveTrackMic"
                : "errors.devicePermission.noLiveTrackCamera",
            ),
            mediaRecorderSupported,
          };
        }

        if (kind === "microphone" && !mediaRecorderSupported) {
          return {
            status: "unsupported",
            verified: false,
            message: tPermError("errors.devicePermission.recorderUnsupported"),
            mediaRecorderSupported: false,
          };
        }

        return {
          status: "granted",
          verified: true,
          message: tPermError(
            kind === "camera"
              ? "errors.devicePermission.grantedCamera"
              : "errors.devicePermission.grantedMic",
          ),
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
