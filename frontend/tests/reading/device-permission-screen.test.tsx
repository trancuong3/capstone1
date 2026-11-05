import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
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

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);
const track = {
  readyState: "live",
  stop: vi.fn(),
  addEventListener: vi.fn(),
};
const stream = {
  getTracks: () => [track],
  getVideoTracks: () => [track],
  getAudioTracks: () => [],
} as unknown as MediaStream;
const getUserMedia = vi.fn();

function childResponse(input: RequestInfo | URL) {
  const path = new URL(String(input)).pathname;
  if (path === `/profiles/children/${TEST_CHILD_ID}`)
    return Response.json(childFixture);
  throw new Error(`Unexpected scanner route: ${path}`);
}

function renderScanner() {
  return render(
    <WithSelectedChild childId={TEST_CHILD_ID}>
      <AppServicesProvider>
        <BookScannerScreen />
      </AppServicesProvider>
    </WithSelectedChild>,
  );
}

beforeEach(() => {
  installApiFetchFixture();
  apiFetchFixture.mockImplementation(async (input) => childResponse(input));
  getUserMedia.mockReset().mockResolvedValue(stream);
  track.stop.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  pushMock.mockReset();
  replaceMock.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("Book scanner entry", () => {
  it("validates the selected child and does not ask for camera until the explicit action", async () => {
    const user = userEvent.setup();
    const view = renderScanner();
    expect(
      await screen.findByRole("heading", {
        name: "Đưa trang sách vào khung camera",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(`${childFixture.alias}`)).toBeInTheDocument();
    expect(screen.getByText(`Lớp ${childFixture.grade}`)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Bật camera để quét" }),
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.any(Object), audio: false }),
    );
    expect(getUserMedia.mock.calls[0]?.[0]).not.toHaveProperty("audio", true);

    view.unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("returns to Dashboard when there is no store selection even if a URL childId is supplied", async () => {
    render(
      <AppStoreProvider>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </AppStoreProvider>,
    );
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=missing",
      );
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Bật camera để quét" }),
    ).not.toBeInTheDocument();
  });
});
