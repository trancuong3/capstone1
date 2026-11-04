import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDevicePermissionService } from "@/lib/api/device-permission-service";

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
