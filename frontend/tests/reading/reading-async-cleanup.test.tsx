import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { TutorAction } from "@/types/reading";

const tutorMocks = vi.hoisted(() => ({
  requestReadExample: vi.fn(),
  retryReadExample: vi.fn(),
}));

vi.mock("@/lib/mock/mock-tutor-service", () => ({
  createMockTutorService: () => tutorMocks,
}));

const tutorAction: TutorAction = {
  action: "READ_EXAMPLE",
  action_id: "70000000-0000-4000-8000-000000000001",
  message_code: "READ_EXAMPLE_READY",
  page_revision_word_id: "50000000-0000-4000-8000-000000000403",
  tts_text: "đang",
};

describe("Reading action cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    tutorMocks.requestReadExample.mockReset();
    tutorMocks.retryReadExample.mockReset();
  });

  it("does not continue a delayed tutor retry after unmount", async () => {
    tutorMocks.retryReadExample.mockResolvedValue(tutorAction);
    const view = render(
      <AppStoreProvider>
        <AppServicesProvider scenario="default">
          <ReadingScreen
            initialUiState="tts-error"
            reconnectMode="recover"
            sessionId="mock-session-001"
          />
        </AppServicesProvider>
      </AppStoreProvider>,
    );

    const retry = await screen.findByRole("button", { name: "Thử nghe lại" });
    vi.useFakeTimers();
    tutorMocks.requestReadExample.mockImplementation(
      () =>
        new Promise<TutorAction>((resolve) => {
          globalThis.setTimeout(() => resolve(tutorAction), 100);
        }),
    );

    fireEvent.click(retry);
    expect(tutorMocks.requestReadExample).toHaveBeenCalledTimes(1);
    view.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(tutorMocks.retryReadExample).not.toHaveBeenCalled();
  });
});
