import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ViReadAssistantWidget } from "@/components/assistant/viread-assistant-widget";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { viMessages } from "@/messages/vi";

const navState = vi.hoisted(() => ({
  pathname: "/dashboard",
}));

const sendAssistantMessageMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/api/assistant-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/assistant-service")>();
  return {
    ...actual,
    sendAssistantMessage: sendAssistantMessageMock,
  };
});

describe("M4-B ViReadAssistantWidget code-splitting", () => {
  beforeEach(() => {
    navState.pathname = "/dashboard";
    sendAssistantMessageMock.mockReset();
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("renders minimized launcher immediately without mounting panel and preserves conversation across minimize/reopen", async () => {
    const user = userEvent.setup();
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Chào ba mẹ!",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 3,
      cached: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
    });

    render(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );

    expect(screen.getByTestId("viread-assistant-launcher")).toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-panel"),
    ).not.toBeInTheDocument();
    expect(sendAssistantMessageMock).not.toHaveBeenCalled();

    // Open dynamic panel
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel", {}, { timeout: 5000 });

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Xin chào{Enter}");
    await waitFor(() =>
      expect(screen.getByText("Chào ba mẹ!")).toBeInTheDocument(),
    );

    // Minimize and reopen -> messages state preserved by lightweight parent
    await user.click(screen.getByTestId("viread-assistant-minimize"));
    expect(
      screen.queryByTestId("viread-assistant-panel"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel", {}, { timeout: 5000 });
    expect(screen.getByText("Chào ba mẹ!")).toBeInTheDocument();
  });

  it("renders recoverable Retry and Close UI on offline chunk rejection without trapping on loading skeleton", async () => {
    vi.resetModules();
    vi.doMock("@/components/assistant/viread-assistant-panel", () => {
      throw new Error("ChunkLoadError: Loading chunk failed");
    });

    try {
      const { ViReadAssistantWidget: IsolatedWidget } =
        await import("@/components/assistant/viread-assistant-widget");
      const { I18nProvider: IsolatedI18nProvider } =
        await import("@/components/i18n/i18n-provider");
      const { viMessages: isolatedViMessages } = await import("@/messages/vi");

      render(
        <IsolatedI18nProvider
          initialLocale="vi"
          initialMessages={isolatedViMessages}
        >
          <IsolatedWidget />
        </IsolatedI18nProvider>,
      );

      fireEvent.click(screen.getByTestId("viread-assistant-launcher"));
      const errorPanel = await screen.findByTestId(
        "viread-assistant-panel-error",
        {},
        { timeout: 5000 },
      );
      expect(errorPanel).toBeInTheDocument();
      expect(
        screen.queryByTestId("viread-assistant-panel-loading"),
      ).not.toBeInTheDocument();

      const retryButton = screen.getByRole("button", { name: "Thử lại" });
      const closeButton = screen.getByRole("button", { name: "Đóng" });
      expect(retryButton).toBeInTheDocument();
      expect(closeButton).toBeInTheDocument();

      // Retry stays cleanly recoverable without locking up on skeleton
      fireEvent.click(retryButton);
      expect(
        await screen.findByTestId(
          "viread-assistant-panel-error",
          {},
          { timeout: 5000 },
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("viread-assistant-panel-loading"),
      ).not.toBeInTheDocument();

      // Close restores the minimized launcher
      fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
      expect(
        screen.queryByTestId("viread-assistant-panel-error"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("viread-assistant-launcher"),
      ).toBeInTheDocument();

      // Reopen triggers clean retry and Escape also closes error UI
      fireEvent.click(screen.getByTestId("viread-assistant-launcher"));
      await screen.findByTestId(
        "viread-assistant-panel-error",
        {},
        { timeout: 5000 },
      );
      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        screen.queryByTestId("viread-assistant-panel-error"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("viread-assistant-launcher"),
      ).toBeInTheDocument();
    } finally {
      vi.doUnmock("@/components/assistant/viread-assistant-panel");
      vi.resetModules();
    }
  });
});
