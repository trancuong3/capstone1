import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ReadingPreparationScreen } from "@/components/reading/reading-preparation-screen";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  bookFixture,
  childFixture,
  pagePreviewFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

const {
  pushMock,
  replaceMock,
  requestAccessMock,
  getPermissionStateMock,
  watchPermissionMock,
  createSessionMock,
  getSnapshotMock,
  devicePermissionServiceMock,
  readingServiceMock,
} = vi.hoisted(() => {
  const requestAccessMock = vi.fn();
  const getPermissionStateMock = vi.fn();
  const watchPermissionMock = vi.fn();
  const createSessionMock = vi.fn();
  const getSnapshotMock = vi.fn();
  return {
    pushMock: vi.fn(),
    replaceMock: vi.fn(),
    requestAccessMock,
    getPermissionStateMock,
    watchPermissionMock,
    createSessionMock,
    getSnapshotMock,
    devicePermissionServiceMock: {
      getSnapshot: getSnapshotMock,
      getMicrophonePermissionState: getPermissionStateMock,
      watchMicrophonePermissionState: watchPermissionMock,
      requestAccess: requestAccessMock,
      retry: vi.fn(),
    },
    readingServiceMock: { create: createSessionMock },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));
vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: () => ({
    devicePermissionService: devicePermissionServiceMock,
    readingService: readingServiceMock,
  }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const secondPage = {
  ...pagePreviewFixture,
  page_id: "15000000-0000-4000-8000-000000000002",
  page_number: 2,
};
let permissionChange:
  | ((
      state:
        | "checking"
        | "granted"
        | "prompt"
        | "denied"
        | "unsupported"
        | "no_device"
        | "device_busy"
        | "error",
    ) => void)
  | null = null;
let releaseMicrophone: (() => void) | null = null;

function dataResponse(input: RequestInfo | URL) {
  const path = new URL(String(input)).pathname;
  if (path === `/profiles/children/${TEST_CHILD_ID}`)
    return Response.json(childFixture);
  if (path === `/books/catalog/${TEST_BOOK_ID}`)
    return Response.json(bookFixture);
  if (path === `/books/catalog/${TEST_BOOK_ID}/preview`)
    return Response.json([pagePreviewFixture, secondPage]);
  throw new Error(`Unexpected preparation API route: ${path}`);
}
function renderPreparation(
  overrides: { pageId?: string; endPageId?: string } = {},
) {
  return render(
    <WithSelectedChild childId={TEST_CHILD_ID}>
      <AppServicesProvider>
        <ReadingPreparationScreen
          bookId={TEST_BOOK_ID}
          pageId={overrides.pageId ?? pagePreviewFixture.page_id}
          endPageId={overrides.endPageId ?? secondPage.page_id}
          confidence="0.91"
        />
      </AppServicesProvider>
    </WithSelectedChild>,
  );
}

beforeEach(() => {
  installApiFetchFixture();
  apiFetchFixture.mockImplementation(async (input) => dataResponse(input));
  pushMock.mockReset();
  replaceMock.mockReset();
  requestAccessMock.mockReset().mockResolvedValue({
    status: "granted",
    verified: true,
    message: "Microphone verified",
    mediaRecorderSupported: true,
  });
  getPermissionStateMock.mockReset().mockResolvedValue("granted");
  watchPermissionMock.mockReset().mockImplementation(async (onChange) => {
    permissionChange = onChange;
    onChange("prompt");
    return () => {
      permissionChange = null;
    };
  });
  createSessionMock.mockReset().mockResolvedValue({
    session_id: "15000000-0000-4000-8000-000000000099",
  });
  getSnapshotMock.mockReset();
  releaseMicrophone = null;
  permissionChange = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("Shared reading preparation", () => {
  it("shows only microphone status, waits for explicit verification, then creates one session with the validated context", async () => {
    const user = userEvent.setup();
    renderPreparation();
    expect(
      await screen.findByRole("heading", { name: "Chuẩn bị đọc sách" }),
    ).toBeInTheDocument();
    expect(screen.getByText(`${childFixture.alias}`)).toBeInTheDocument();
    expect(
      screen.getByText(/Trang OCR xác nhận: Trang 1 · Độ tin cậy 91%/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Microphone" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Camera")).not.toBeInTheDocument();
    expect(getSnapshotMock).not.toHaveBeenCalled();
    expect(requestAccessMock).not.toHaveBeenCalled();
    const start = screen.getByRole("button", { name: "Bắt đầu đọc" });
    expect(start).toBeDisabled();
    expect(createSessionMock).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Kiểm tra và cấp quyền microphone" }),
    );
    await waitFor(() => expect(start).toBeEnabled());
    expect(requestAccessMock).toHaveBeenCalledExactlyOnceWith("microphone");
    expect(getPermissionStateMock).toHaveBeenCalledOnce();
    expect(getSnapshotMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();

    await user.click(start);
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledOnce());
    expect(createSessionMock).toHaveBeenCalledWith({
      book_id: TEST_BOOK_ID,
      child_id: TEST_CHILD_ID,
      mode: "realtime",
      selected_page_id: pagePreviewFixture.page_id,
      selected_page_revision_id:
        pagePreviewFixture.current_verified_revision_id,
      end_page_id: secondPage.page_id,
    });
    expect(pushMock).toHaveBeenCalledWith(
      `/reading/15000000-0000-4000-8000-000000000099?state=ready&pageId=${pagePreviewFixture.page_id}`,
    );
  });

  it("blocks session creation when microphone verification fails and handles permission revocation", async () => {
    const user = userEvent.setup();
    requestAccessMock.mockResolvedValueOnce({
      status: "denied",
      verified: false,
      message: "Vui lòng cấp quyền microphone trong cài đặt trình duyệt.",
      mediaRecorderSupported: true,
    });
    renderPreparation();
    const verify = await screen.findByRole("button", {
      name: "Kiểm tra và cấp quyền microphone",
    });
    const start = screen.getByRole("button", { name: "Bắt đầu đọc" });
    await user.click(verify);
    expect(
      await screen.findByText(
        "Vui lòng cấp quyền microphone trong cài đặt trình duyệt.",
      ),
    ).toBeInTheDocument();
    expect(start).toBeDisabled();
    expect(createSessionMock).not.toHaveBeenCalled();

    requestAccessMock.mockResolvedValueOnce({
      status: "granted",
      verified: true,
      message: "Microphone verified",
      mediaRecorderSupported: true,
    });
    await user.click(
      screen.getByRole("button", { name: "Kiểm tra và cấp quyền microphone" }),
    );
    await waitFor(() => expect(start).toBeEnabled());
    act(() => permissionChange?.("denied"));
    await waitFor(() => expect(start).toBeDisabled());
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("prevents concurrent microphone requests", async () => {
    const user = userEvent.setup();
    requestAccessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMicrophone = () =>
            resolve({
              status: "granted",
              verified: true,
              message: "Microphone verified",
              mediaRecorderSupported: true,
            });
        }),
    );
    renderPreparation();
    const verify = await screen.findByRole("button", {
      name: "Kiểm tra và cấp quyền microphone",
    });
    await user.click(verify);
    await user.click(verify);
    expect(requestAccessMock).toHaveBeenCalledOnce();
    await act(async () => releaseMicrophone?.());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Bắt đầu đọc" })).toBeEnabled(),
    );
  });

  it("does not replace an invalid explicit OCR page with the first page", async () => {
    renderPreparation({ pageId: "15000000-0000-4000-8000-000000000099" });
    expect(
      await screen.findByText(
        /Trang OCR không nằm trong danh sách trang hợp lệ/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bắt đầu đọc" })).toBeDisabled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
