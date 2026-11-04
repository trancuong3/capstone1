import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { DevicePermissionScreen } from "@/components/reading/device-permission-screen";
import {
  clearDevicePermissionVerification,
  markDevicePermissionVerified,
} from "@/lib/api/device-permission-service";

const { getSnapshotMock, requestAccessMock, retryMock, pushMock, replaceMock } =
  vi.hoisted(() => ({
    getSnapshotMock: vi.fn(),
    requestAccessMock: vi.fn(),
    retryMock: vi.fn(),
    pushMock: vi.fn(),
    replaceMock: vi.fn(),
  }));

vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: () => ({
    devicePermissionService: {
      getSnapshot: getSnapshotMock,
      requestAccess: requestAccessMock,
      retry: retryMock,
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
}));

const childId = "41ee0744-5a14-4d2c-bcbc-4cd566e1e4c4";

describe("Device permission gate", () => {
  beforeEach(() => {
    clearDevicePermissionVerification();
    getSnapshotMock.mockReset().mockResolvedValue({
      camera: "prompt",
      microphone: "prompt",
      mediaDevicesSupported: true,
      mediaRecorderSupported: true,
      secureContext: true,
    });
    requestAccessMock.mockReset().mockResolvedValue({
      status: "granted",
      verified: true,
      message: "Device access verified",
      mediaRecorderSupported: true,
    });
    retryMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
  });

  it("does not allow scanner navigation until camera and microphone are verified", async () => {
    const user = userEvent.setup();
    render(
      <DevicePermissionScreen
        flow="global-book-scan"
        childId={childId}
      />,
    );

    const continueButton = screen.getByRole("button", {
      name: "Tiếp tục quét trang sách",
    });
    expect(continueButton).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: "Kiểm tra và cấp quyền" }),
    );

    await screen.findByText("Thiết bị đã sẵn sàng");
    expect(requestAccessMock).toHaveBeenNthCalledWith(1, "camera");
    expect(requestAccessMock).toHaveBeenNthCalledWith(2, "microphone");
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);
    expect(pushMock).toHaveBeenCalledWith(
      `/book-scanner?flow=global-book-scan&childId=${childId}`,
    );
  });

  it("keeps navigation blocked when either device is denied", async () => {
    const user = userEvent.setup();
    requestAccessMock
      .mockResolvedValueOnce({
        status: "denied",
        verified: false,
        message: "Camera permission denied",
        mediaRecorderSupported: true,
      })
      .mockResolvedValueOnce({
        status: "granted",
        verified: true,
        message: "Microphone verified",
        mediaRecorderSupported: true,
      });

    render(<DevicePermissionScreen childId={childId} />);

    await user.click(
      screen.getByRole("button", { name: "Kiểm tra và cấp quyền" }),
    );

    await screen.findByText(/Camera permission denied/);
    expect(
      screen.getByRole("button", { name: "Tiếp tục quét trang sách" }),
    ).toBeDisabled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("keeps navigation blocked when the microphone check fails", async () => {
    const user = userEvent.setup();
    requestAccessMock
      .mockResolvedValueOnce({
        status: "granted",
        verified: true,
        message: "Camera verified",
        mediaRecorderSupported: true,
      })
      .mockResolvedValueOnce({
        status: "denied",
        verified: false,
        message: "Microphone permission denied",
        mediaRecorderSupported: true,
      });

    render(<DevicePermissionScreen childId={childId} />);

    await user.click(
      screen.getByRole("button", { name: "Kiểm tra và cấp quyền" }),
    );

    await screen.findByText(/Microphone permission denied/);
    expect(
      screen.getByRole("button", { name: "Tiếp tục quét trang sách" }),
    ).toBeDisabled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("supports retrying one device after the first verification failed", async () => {
    const user = userEvent.setup();
    requestAccessMock
      .mockResolvedValueOnce({
        status: "denied",
        verified: false,
        message: "Camera permission denied",
        mediaRecorderSupported: true,
      })
      .mockResolvedValueOnce({
        status: "granted",
        verified: true,
        message: "Camera verified",
        mediaRecorderSupported: true,
      });

    render(<DevicePermissionScreen childId={childId} />);

    const retryButton = screen.getByRole("button", {
      name: "Thử lại quyền Camera",
    });
    await user.click(retryButton);
    await screen.findByText(/Camera permission denied/);
    expect(
      screen.getByRole("button", { name: "Tiếp tục quét trang sách" }),
    ).toBeDisabled();

    await user.click(retryButton);
    await waitFor(() => {
      expect(requestAccessMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Đã xác minh")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Tiếp tục quét trang sách" }),
    ).toBeDisabled();
  });

  it("opens the scanner only when a current verification ticket exists", async () => {
    markDevicePermissionVerified();

    render(<BookScannerScreen childId={childId} />);

    expect(
      await screen.findByRole("heading", {
        name: "Đưa trang sách vào khung camera",
      }),
    ).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("redirects direct scanner visits back to permission verification", async () => {
    render(<BookScannerScreen childId={childId} />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        `/device-permissions?flow=global-book-scan&childId=${childId}`,
      );
    });
    expect(
      screen.queryByRole("heading", {
        name: "Đưa trang sách vào khung camera",
      }),
    ).not.toBeInTheDocument();
  });
});
