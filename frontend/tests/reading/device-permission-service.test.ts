import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevicePermissionService } from "@/lib/api/device-permission-service";

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);
const originalPermissionsDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "permissions",
);
const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);

function restoreDescriptor(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

function fakeStream(kind: "audio" | "video") {
  const track = { kind, readyState: "live", stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => (kind === "video" ? [track] : []),
    getAudioTracks: () => (kind === "audio" ? [track] : []),
  } as unknown as MediaStream;
  return { stream, track };
}

function installMediaDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
}

function installPermissions(query: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query },
  });
}

describe("DevicePermissionService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreDescriptor(
      navigator,
      "mediaDevices",
      originalMediaDevicesDescriptor,
    );
    restoreDescriptor(navigator, "permissions", originalPermissionsDescriptor);
    restoreDescriptor(
      window,
      "isSecureContext",
      originalSecureContextDescriptor,
    );
  });

  it("verifies live camera access for the scanner and stops the temporary stream", async () => {
    const { stream, track } = fakeStream("video");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);
    const result =
      await createDevicePermissionService().requestAccess("camera");
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.any(Object), audio: false }),
    );
    expect(result).toMatchObject({ status: "granted", verified: true });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each(["granted", "prompt", "denied"] as const)(
    "reads the actual microphone permission state: %s",
    async (state) => {
      const query = vi.fn().mockResolvedValue({ state });
      installPermissions(query);
      expect(
        await createDevicePermissionService().getMicrophonePermissionState(),
      ).toBe(state);
      expect(query).toHaveBeenCalledExactlyOnceWith({ name: "microphone" });
    },
  );

  it("distinguishes an unsupported Permissions API from a failed query", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: undefined,
    });
    expect(
      await createDevicePermissionService().getMicrophonePermissionState(),
    ).toBe("unsupported");
    installPermissions(
      vi.fn().mockRejectedValue(new TypeError("Unsupported descriptor")),
    );
    expect(
      await createDevicePermissionService().getMicrophonePermissionState(),
    ).toBe("unsupported");
    installPermissions(
      vi.fn().mockRejectedValue(new Error("Unexpected failure")),
    );
    expect(
      await createDevicePermissionService().getMicrophonePermissionState(),
    ).toBe("error");
  });

  it("subscribes to microphone permission changes and removes the listener", async () => {
    const listeners = new Set<() => void>();
    const permissionStatus = {
      state: "prompt",
      addEventListener: vi.fn((_event: string, listener: () => void) =>
        listeners.add(listener),
      ),
      removeEventListener: vi.fn((_event: string, listener: () => void) =>
        listeners.delete(listener),
      ),
    } as unknown as PermissionStatus & { state: PermissionState };
    installPermissions(vi.fn().mockResolvedValue(permissionStatus));
    const onChange = vi.fn();
    const cleanup =
      await createDevicePermissionService().watchMicrophonePermissionState(
        onChange,
      );
    expect(onChange).toHaveBeenLastCalledWith("prompt");
    permissionStatus.state = "granted";
    listeners.forEach((listener) => listener());
    expect(onChange).toHaveBeenLastCalledWith("granted");
    cleanup();
    expect(permissionStatus.removeEventListener).toHaveBeenCalledOnce();
    permissionStatus.state = "denied";
    listeners.forEach((listener) => listener());
    expect(onChange).toHaveBeenLastCalledWith("granted");
  });

  it("verifies audio-only microphone access and stops every temporary track", async () => {
    const trackA = { kind: "audio", readyState: "live", stop: vi.fn() };
    const trackB = { kind: "audio", readyState: "live", stop: vi.fn() };
    const stream = {
      getTracks: () => [trackA, trackB],
      getAudioTracks: () => [trackA, trackB],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);
    vi.stubGlobal("MediaRecorder", class TestMediaRecorder {});

    const result =
      await createDevicePermissionService().requestAccess("microphone");
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: true,
      video: false,
    });
    expect(result).toMatchObject({
      status: "granted",
      verified: true,
      mediaRecorderSupported: true,
    });
    expect(trackA.stop).toHaveBeenCalledOnce();
    expect(trackB.stop).toHaveBeenCalledOnce();
  });

  it("does not verify a microphone without at least one live audio track", async () => {
    const { stream, track } = fakeStream("video");
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    vi.stubGlobal("MediaRecorder", class TestMediaRecorder {});
    const result =
      await createDevicePermissionService().requestAccess("microphone");
    expect(result.status).toBe("no_device");
    expect(result.verified).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["NotAllowedError", "denied", "cấp quyền microphone"],
    ["PermissionDeniedError", "denied", "cấp quyền microphone"],
    ["NotFoundError", "no_device", "Không tìm thấy microphone"],
    ["DevicesNotFoundError", "no_device", "Không tìm thấy microphone"],
    ["NotReadableError", "device_busy", "đang được ứng dụng khác sử dụng"],
    ["TrackStartError", "device_busy", "đang được ứng dụng khác sử dụng"],
    ["OverconstrainedError", "error", "cấu hình"],
    ["UnexpectedError", "error", "Không thể kiểm tra microphone"],
  ] as const)("maps microphone %s to %s", async (name, status, message) => {
    const error = new Error(name);
    error.name = name;
    installMediaDevices(vi.fn().mockRejectedValue(error));
    const result =
      await createDevicePermissionService().requestAccess("microphone");
    expect(result.status).toBe(status);
    expect(result.verified).toBe(false);
    expect(result.message).toContain(message);
  });

  it("reports insecure context separately and does not ask for microphone access", async () => {
    const getUserMedia = vi.fn();
    installMediaDevices(getUserMedia);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const result =
      await createDevicePermissionService().requestAccess("microphone");
    expect(result.status).toBe("error");
    expect(result.message).toContain("HTTPS hoặc localhost");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports missing MediaDevices as unsupported", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Reflect.deleteProperty(navigator, "mediaDevices");
    const result =
      await createDevicePermissionService().requestAccess("microphone");
    expect(result.status).toBe("unsupported");
    expect(result.message).toContain("không hỗ trợ");
  });

  it("keeps camera and microphone permission inspection separate", async () => {
    const query = vi.fn(async (descriptor: PermissionDescriptor) => ({
      state: descriptor.name === "camera" ? "denied" : "prompt",
      onchange: null,
    }));
    installMediaDevices(vi.fn());
    installPermissions(query);
    const snapshot = await createDevicePermissionService().getSnapshot();
    expect(query).toHaveBeenCalledTimes(2);
    expect(snapshot.camera).toBe("denied");
    expect(snapshot.microphone).toBe("prompt");
  });
});
