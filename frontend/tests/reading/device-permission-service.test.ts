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
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}

function fakeStream(kind: "audio" | "video") {
  const track = {
    kind,
    readyState: "live",
    stop: vi.fn(),
  };
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

describe("DevicePermissionService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreDescriptor(navigator, "mediaDevices", originalMediaDevicesDescriptor);
    restoreDescriptor(navigator, "permissions", originalPermissionsDescriptor);
    restoreDescriptor(window, "isSecureContext", originalSecureContextDescriptor);
  });

  it("verifies a live camera track and always stops the temporary stream", async () => {
    const { stream, track } = fakeStream("video");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);

    const result = await createDevicePermissionService().requestAccess("camera");

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          facingMode: { ideal: "environment" },
        }),
        audio: false,
      }),
    );
    expect(result).toMatchObject({
      status: "granted",
      verified: true,
    });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("maps a browser permission denial without calling it a missing device", async () => {
    const deniedError = new Error("Permission was denied");
    deniedError.name = "NotAllowedError";
    const getUserMedia = vi.fn().mockRejectedValue(deniedError);
    installMediaDevices(getUserMedia);

    const result = await createDevicePermissionService().requestAccess("camera");

    expect(result.status).toBe("denied");
    expect(result.verified).toBe(false);
    expect(result.message).toContain("từ chối");
  });

  it("verifies a live microphone track when MediaRecorder is supported", async () => {
    const { stream, track } = fakeStream("audio");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);
    vi.stubGlobal("MediaRecorder", class TestMediaRecorder {});

    const result = await createDevicePermissionService().requestAccess("microphone");

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: true,
      video: false,
    });
    expect(result).toMatchObject({
      status: "granted",
      verified: true,
      mediaRecorderSupported: true,
    });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not pass microphone verification when MediaRecorder is unsupported", async () => {
    const { stream, track } = fakeStream("audio");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);
    vi.stubGlobal("MediaRecorder", undefined);

    const result = await createDevicePermissionService().requestAccess("microphone");

    expect(result.status).toBe("granted");
    expect(result.verified).toBe(false);
    expect(result.mediaRecorderSupported).toBe(false);
    expect(result.message).toContain("MediaRecorder");
    expect(track.stop).toHaveBeenCalledOnce();
  });


  it("requires a secure context before asking the browser for a device", async () => {
    const getUserMedia = vi.fn();
    installMediaDevices(getUserMedia);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    const result = await createDevicePermissionService().requestAccess("camera");

    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.message).toContain("HTTPS");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports MediaDevices as unavailable when getUserMedia is unsupported", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Reflect.deleteProperty(navigator, "mediaDevices");

    const result = await createDevicePermissionService().requestAccess("microphone");

    expect(result.status).toBe("unavailable");
    expect(result.verified).toBe(false);
    expect(result.message).toContain("không hỗ trợ");
  });

  it("reports unsupported permission descriptors as unknown, not granted", async () => {
    const getUserMedia = vi.fn();
    installMediaDevices(getUserMedia);
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockRejectedValue(new TypeError("Unsupported descriptor")),
      },
    });

    const snapshot = await createDevicePermissionService().getSnapshot();

    expect(snapshot.camera).toBe("unknown");
    expect(snapshot.microphone).toBe("unknown");
  });

  it("queries camera and microphone permission states independently", async () => {
    const query = vi.fn(async (descriptor: PermissionDescriptor) => ({
      state: descriptor.name === "camera" ? "denied" : "prompt",
      onchange: null,
    }));
    installMediaDevices(vi.fn());
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query },
    });

    const snapshot = await createDevicePermissionService().getSnapshot();

    expect(query).toHaveBeenCalledTimes(2);
    expect(snapshot.camera).toBe("denied");
    expect(snapshot.microphone).toBe("prompt");
  });

  it("classifies a hardware busy error separately from a permission denial", async () => {
    const busyError = new Error("Device is busy");
    busyError.name = "NotReadableError";
    installMediaDevices(vi.fn().mockRejectedValue(busyError));

    const result = await createDevicePermissionService().requestAccess("microphone");

    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.message).toContain("đang bận");
  });

  it("classifies unsatisfied device constraints as an error", async () => {
    const constraintError = new Error("No matching device mode");
    constraintError.name = "OverconstrainedError";
    installMediaDevices(vi.fn().mockRejectedValue(constraintError));

    const result = await createDevicePermissionService().requestAccess("camera");

    expect(result.status).toBe("error");
    expect(result.message).toContain("cấu hình");
  });

  it("classifies a missing physical device as unavailable", async () => {
    const missingError = new Error("No camera found");
    missingError.name = "NotFoundError";
    const getUserMedia = vi.fn().mockRejectedValue(missingError);
    installMediaDevices(getUserMedia);

    const result = await createDevicePermissionService().requestAccess("camera");

    expect(result.status).toBe("unavailable");
    expect(result.verified).toBe(false);
  });
});
