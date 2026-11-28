import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openViReadAssistant,
  ViReadAssistantWidget,
} from "@/components/assistant/viread-assistant-widget";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { SELECTED_CHILD_LOCAL_EVENT } from "@/lib/cache/selected-child-storage";
import { viMessages } from "@/messages/vi";
import type { ChildProfileDTO } from "@/types/child";

const navState = vi.hoisted(() => ({
  pathname: "/dashboard",
  routerPush: vi.fn(),
}));

const sendAssistantMessageMock = vi.hoisted(() => vi.fn());
const readAssistantChildContextMock = vi.hoisted(() => vi.fn());
const selectChildFromAssistantMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  userId: "91000000-0000-4000-8000-000000000001" as string | null,
  throwOnCreate: false,
  callbacks: new Set<
    (event: string, session: { user: { id: string } } | null) => void
  >(),
  unsubscribe: vi.fn(),
  emit(event: string, session: { user: { id: string } } | null) {
    for (const listener of Array.from(this.callbacks)) {
      listener(event, session);
    }
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({
    push: navState.routerPush,
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => {
    if (authState.throwOnCreate) {
      throw new Error("Missing Supabase config in test");
    }
    return {
      auth: {
        getSession: async () => ({
          data: {
            session: authState.userId
              ? { user: { id: authState.userId } }
              : null,
          },
          error: null,
        }),
        onAuthStateChange: (
          cb: (event: string, session: { user: { id: string } } | null) => void,
        ) => {
          authState.callbacks.add(cb);
          return {
            data: {
              subscription: {
                unsubscribe: () => {
                  authState.callbacks.delete(cb);
                  authState.unsubscribe();
                },
              },
            },
          };
        },
      },
    };
  },
}));

vi.mock("@/lib/api/assistant-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/assistant-service")>();
  return {
    ...actual,
    sendAssistantMessage: sendAssistantMessageMock,
  };
});

vi.mock("@/lib/assistant/child-gate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/assistant/child-gate")>();
  return {
    ...actual,
    readAssistantChildContext: readAssistantChildContextMock,
    selectChildFromAssistant: selectChildFromAssistantMock,
  };
});

const PARENT_ID = "91000000-0000-4000-8000-000000000001";
const OTHER_PARENT_ID = "91000000-0000-4000-8000-000000000099";
const CHILD_ONE: ChildProfileDTO = {
  id: "92000000-0000-4000-8000-000000000001",
  parent_id: PARENT_ID,
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-11-27T10:00:00Z",
};
const CHILD_TWO: ChildProfileDTO = {
  id: "92000000-0000-4000-8000-000000000002",
  parent_id: PARENT_ID,
  alias: "Bé Bình",
  grade: 4,
  settings: {},
  created_at: "2026-11-27T10:05:00Z",
};

function renderWidget() {
  return render(
    <I18nProvider initialLocale="vi" initialMessages={viMessages}>
      <ViReadAssistantWidget />
    </I18nProvider>,
  );
}

describe("ViReadAssistantWidget", () => {
  beforeEach(() => {
    navState.pathname = "/dashboard";
    navState.routerPush.mockReset();
    sendAssistantMessageMock.mockReset();
    readAssistantChildContextMock.mockReset();
    selectChildFromAssistantMock.mockReset();
    authState.userId = PARENT_ID;
    authState.throwOnCreate = false;
    authState.callbacks.clear();
    authState.unsubscribe.mockReset();
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: null,
      children: [CHILD_ONE],
      selectedChild: null,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete (window as Window & { SpeechRecognition?: unknown })
      .SpeechRecognition;
    delete (window as Window & { webkitSpeechRecognition?: unknown })
      .webkitSpeechRecognition;
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete (window as Window & { SpeechRecognition?: unknown })
      .SpeechRecognition;
    delete (window as Window & { webkitSpeechRecognition?: unknown })
      .webkitSpeechRecognition;
  });

  it("renders a compact minimized launcher by default and opens a non-modal complementary panel with page guides", async () => {
    navState.pathname = "/book-scanner";
    const user = userEvent.setup();
    renderWidget();

    const launcher = screen.getByTestId("viread-assistant-launcher");
    expect(launcher).toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-panel"),
    ).not.toBeInTheDocument();

    await user.click(launcher);

    const panel = await screen.findByTestId(
      "viread-assistant-panel",
      undefined,
      { timeout: 5000 },
    );
    expect(panel).toHaveAttribute("role", "complementary");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(panel).getByText("Quét sách giấy")).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", {
        name: "Mẹo chụp trang sách để OCR chuẩn nhất?",
      }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByTestId("viread-assistant-panel"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("viread-assistant-launcher")).toBeInTheDocument();
  });

  it("adapts compact edge-docked positioning on /reading/* routes to avoid obstructing header, topBar, and reading dock", () => {
    navState.pathname = "/reading/session-123";
    renderWidget();

    const wrap = screen.getByTestId("viread-assistant-launcher-wrap");
    expect(wrap.className).toContain("top-[42%]");
    expect(wrap.className).toContain("end-0");
    expect(wrap.className).not.toContain("bottom-");
    expect(wrap.className).not.toContain("top-14");
  });

  it("lets users hide the assistant completely and restore it via edge tab or openViReadAssistant event", async () => {
    const user = userEvent.setup();
    renderWidget();

    // Hide via quick-hide micro button next to launcher
    await user.click(screen.getByTestId("viread-assistant-quick-hide"));
    expect(
      screen.queryByTestId("viread-assistant-launcher"),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("viread:assistant:visibility")).toBe(
      "hidden",
    );

    const hiddenTab = screen.getByTestId("viread-assistant-hidden-tab");
    expect(hiddenTab).toBeInTheDocument();

    // Restore by clicking the slim edge tab
    await user.click(within(hiddenTab).getByRole("button"));
    expect(screen.getByTestId("viread-assistant-launcher")).toBeInTheDocument();
    expect(window.localStorage.getItem("viread:assistant:visibility")).toBe(
      "minimized",
    );

    // Open -> Hide from panel header -> Reopen programmatically (e.g. from Help & Support)
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel", undefined, {
      timeout: 5000,
    });
    await user.click(screen.getByTestId("viread-assistant-hide"));
    expect(
      screen.getByTestId("viread-assistant-hidden-tab"),
    ).toBeInTheDocument();

    await act(async () => {
      openViReadAssistant();
    });
    expect(
      await screen.findByTestId("viread-assistant-panel", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
  });

  it("sends tiered chat messages, displays source tier/latency/actions, supports deeper AI & clear", async () => {
    const user = userEvent.setup();
    sendAssistantMessageMock
      .mockResolvedValueOnce({
        reply: "Bước 1: Mở Hồ sơ bé.\n• Chọn Tạo hồ sơ bé và nhập tên, lớp.",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 4,
        cached: false,
        role_scope: "parent",
        quick_actions: [{ label: "Mở Hồ sơ bé", href: "/children" }],
        suggested_prompts: ["Cách bắt đầu buổi đọc?"],
      })
      .mockResolvedValueOnce({
        reply: "Giải thích chi tiết từ Ollama cục bộ cho gia đình bạn.",
        source_tier: "tier_2_ollama",
        provider_id: "ollama_local",
        model_id: "qwen3-vl:4b-instruct-q4_K_M",
        bandwidth_applied: "high",
        latency_ms: 1240,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
      });

    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel", undefined, {
      timeout: 5000,
    });

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Làm sao tạo hồ sơ bé?{Enter}");

    await waitFor(() =>
      expect(screen.getByText(/Bước 1: Mở Hồ sơ bé/)).toBeInTheDocument(),
    );
    expect(sendAssistantMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Làm sao tạo hồ sơ bé?",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "high",
        force_llm: false,
      }),
      expect.any(Object),
    );
    expect(
      screen.getByTestId("viread-assistant-source-meta"),
    ).toHaveTextContent("Hướng dẫn nhanh · 4ms");
    expect(screen.getByRole("link", { name: "Mở Hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children",
    );

    // Trigger "Hỏi AI sâu hơn" (force_llm: true) -> displays Ollama tier
    await user.click(screen.getByRole("button", { name: /Hỏi AI sâu hơn/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Giải thích chi tiết từ Ollama cục bộ/),
      ).toBeInTheDocument(),
    );
    expect(sendAssistantMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Làm sao tạo hồ sơ bé?",
        force_llm: true,
      }),
      expect.any(Object),
    );
    const metas = screen.getAllByTestId("viread-assistant-source-meta");
    expect(metas[1]).toHaveTextContent("Ollama cục bộ · 1.2s");

    // Clear conversation
    await user.click(screen.getByTestId("viread-assistant-clear"));
    expect(
      screen.queryByText(/Giải thích chi tiết từ Ollama cục bộ/),
    ).not.toBeInTheDocument();
  });

  it("cycles bandwidth preferences (auto -> low -> high) and forwards low bandwidth to API", async () => {
    const user = userEvent.setup();
    sendAssistantMessageMock.mockResolvedValue({
      reply: "Trả lời ngắn gọn tiết kiệm dữ liệu.",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "low",
      latency_ms: 2,
      cached: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
    });

    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel", undefined, {
      timeout: 5000,
    });

    const bwBtn = screen.getByTestId("viread-assistant-bandwidth-btn");
    expect(bwBtn).toHaveTextContent("Tự động · Nhanh");

    await user.click(bwBtn);
    expect(bwBtn).toHaveTextContent("Tiết kiệm");
    expect(window.localStorage.getItem("viread:assistant:bandwidth")).toBe(
      "low",
    );

    await user.click(
      screen.getByRole("button", {
        name: "Cách bắt đầu buổi đọc đầu tiên cho bé?",
      }),
    );

    await waitFor(() =>
      expect(sendAssistantMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          bandwidth_profile: "low",
        }),
        expect.any(Object),
      ),
    );
  });

  it("renders bold/code/italic markdown safely without raw asterisks, refreshes page guides on route change, and preserves draft input on deeper AI click", async () => {
    const user = userEvent.setup();
    sendAssistantMessageMock
      .mockResolvedValueOnce({
        reply:
          "### Hướng dẫn nhanh\n1. Mở **Quản lý đọc** (`/reading-management`).\n* *Lưu ý: kiểm tra email đã xác minh.*",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 5,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: ["Gợi ý riêng của trang Tổng quan?"],
      })
      .mockResolvedValueOnce({
        reply: "Câu trả lời AI đã lưu cache.",
        source_tier: "cache",
        provider_id: "gemini_primary",
        model_id: "gemini-3.5-flash-lite",
        bandwidth_applied: "high",
        latency_ms: 2,
        cached: true,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
      });

    const { rerender } = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel", undefined, {
      timeout: 5000,
    });

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Cách đặt lịch nhắc đọc?{Enter}");

    await waitFor(() =>
      expect(screen.getByText("Quản lý đọc")).toBeInTheDocument(),
    );
    const panel = screen.getByTestId("viread-assistant-panel");
    expect(panel.textContent).not.toContain("**");
    expect(panel.textContent).not.toContain("###");
    expect(panel.querySelector("strong")?.textContent).toBe("Quản lý đọc");
    expect(panel.querySelector("code")?.textContent).toBe(
      "/reading-management",
    );
    expect(panel.querySelector("em")?.textContent).toBe(
      "Lưu ý: kiểm tra email đã xác minh.",
    );

    // Typing draft text then clicking "Hỏi AI sâu hơn" must preserve draft text!
    await user.type(input, "Câu hỏi nháp đang gõ");
    await user.click(screen.getByRole("button", { name: /Hỏi AI sâu hơn/i }));
    await waitFor(() =>
      expect(
        screen.getByText("Câu trả lời AI đã lưu cache."),
      ).toBeInTheDocument(),
    );
    expect(input).toHaveValue("Câu hỏi nháp đang gõ");
    // Cached AI answer (provider_id=gemini_primary) must NOT display a second "Hỏi AI sâu hơn" button.
    expect(
      screen.getAllByRole("button", { name: /Hỏi AI sâu hơn/i }),
    ).toHaveLength(1);

    // Navigating to /book-scanner refreshes quick guides away from old page's followups.
    navState.pathname = "/book-scanner";
    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    expect(
      within(panel).getByRole("button", {
        name: "Mẹo chụp trang sách để OCR chuẩn nhất?",
      }),
    ).toBeInTheDocument();
  });

  it("keeps initial client render identical to SSR when localStorage has hidden state (zero hydration mismatch)", async () => {
    window.localStorage.setItem("viread:assistant:visibility", "hidden");

    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const element = (
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>
    );

    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockReturnValue(null);
    const ssrHtml = renderToString(element);
    getItemSpy.mockRestore();

    const container = document.createElement("div");
    container.innerHTML = ssrHtml;
    document.body.appendChild(container);

    const consoleErrors: unknown[][] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        consoleErrors.push(args);
      });

    let root: ReturnType<typeof hydrateRoot> | null = null;
    try {
      await act(async () => {
        root = hydrateRoot(container, element);
      });
      expect(consoleErrors).toEqual([]);
      await waitFor(() =>
        expect(
          within(container).getByTestId("viread-assistant-hidden-tab"),
        ).toBeInTheDocument(),
      );
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it("renders Yes/No own-scope navigation card, navigates only on Có, blocks /admin/* offers, and supports loading Cancel", async () => {
    navState.pathname = "/dashboard";
    const user = userEvent.setup();

    const rejectRef: { fn?: (reason?: unknown) => void } = {};
    sendAssistantMessageMock
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRef.fn = reject;
          }),
      )
      .mockResolvedValueOnce({
        reply: "Bạn có thể đổi mật khẩu trong Cài đặt tài khoản của bạn nhé!",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 12,
        cached: false,
        role_scope: "parent",
        quick_actions: [{ label: "Mở Cài đặt", href: "/settings" }],
        suggested_prompts: [],
        navigation_offer: {
          label: "Đi đến trang Cài đặt đổi mật khẩu",
          href: "/settings",
          reason: "Đổi mật khẩu cho chính tài khoản của bạn.",
        },
      })
      .mockResolvedValueOnce({
        reply: "Mình gợi ý mở trang Cài đặt nhé!",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 10,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
        navigation_offer: {
          label: "Đi đến trang Cài đặt đổi mật khẩu",
          href: "/settings",
          reason: "Đổi mật khẩu cho chính tài khoản của bạn.",
        },
      })
      .mockResolvedValueOnce({
        reply: "Không thể chuyển sang Admin.",
        source_tier: "tier_0_kb",
        provider_id: "viread_scope_guard",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 8,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
        navigation_offer: {
          label: "Admin",
          href: "/admin/health",
        },
      });

    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");

    // 1. Messenger-style typing bubble + circular avatar + 3 waving dots + Cancel
    await user.type(input, "Tôi muốn đổi mật khẩu");
    await user.click(screen.getByLabelText("Gửi câu hỏi"));
    const loadingCard = await screen.findByTestId(
      "viread-assistant-loading-card",
    );
    expect(loadingCard).toBeInTheDocument();
    const typingAvatar = screen.getByTestId("viread-assistant-typing-avatar");
    expect(typingAvatar).toHaveClass("rounded-full");
    expect(
      screen.getByTestId("viread-assistant-typing-bubble"),
    ).toBeInTheDocument();
    const typingDots = screen.getAllByTestId("viread-assistant-typing-dot");
    expect(typingDots).toHaveLength(3);
    expect(typingDots[0]).toHaveClass("viread-messenger-dot-1");
    expect(typingDots[1]).toHaveClass("viread-messenger-dot-2");
    expect(typingDots[2]).toHaveClass("viread-messenger-dot-3");
    await user.click(screen.getByTestId("viread-assistant-cancel"));
    rejectRef.fn?.(new DOMException("Aborted", "AbortError"));
    expect(input).toHaveValue("Tôi muốn đổi mật khẩu");

    // 2. Submit -> shows Yes/No navigation confirmation -> click Không stays on page
    await user.click(screen.getByLabelText("Gửi câu hỏi"));
    expect(
      await screen.findByTestId("viread-assistant-nav-card"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByTestId("viread-assistant-message-avatar").length,
    ).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByTestId("viread-assistant-nav-no"));
    expect(navState.routerPush).not.toHaveBeenCalled();
    expect(
      screen.getByText("Đã giữ nguyên trang hiện tại"),
    ).toBeInTheDocument();

    // 3. Submit -> click Có triggers router.push("/settings")
    await user.type(input, "Mở trang đổi mật khẩu");
    await user.click(screen.getByLabelText("Gửi câu hỏi"));
    const yesBtn = await screen.findByTestId("viread-assistant-nav-yes");
    await user.click(yesBtn);
    expect(navState.routerPush).toHaveBeenCalledTimes(1);
    expect(navState.routerPush).toHaveBeenCalledWith("/settings");

    // 4. Disallowed /admin/health offer in parent scope is never rendered
    await user.type(input, "Chuyển sang trang admin");
    await user.click(screen.getByLabelText("Gửi câu hỏi"));
    expect(
      await screen.findByText("Không thể chuyển sang Admin."),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-nav-yes"),
    ).not.toBeInTheDocument();
  });

  it("intercepts missing child with 1-child inline picker, keeps compact height, and navigates after picking", async () => {
    navState.pathname = "/dashboard";
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: null,
      children: [CHILD_ONE],
      selectedChild: null,
    });
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Mình mở **Kho sách** (`/books`) cho bé nhé!",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 8,
      cached: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
      navigation_offer: {
        label: "Mở Kho sách ViRead",
        href: "/books",
        reason: "Chọn sách phù hợp trình độ của bé.",
        requires_child_selection: true,
        scenario_id: "books_catalog",
      },
    });

    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const panel = await screen.findByTestId("viread-assistant-panel");
    expect(panel.className).toContain("w-[min(352px,calc(100vw-1.5rem))]");
    expect(panel.className).toContain("h-[min(420px,calc(100dvh-7.5rem))]");

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Mở kho sách{Enter}");

    expect(
      await screen.findByTestId("viread-assistant-child-required-notice"),
    ).toHaveTextContent("Cần chọn hồ sơ bé trước khi mở trang này");

    await user.click(screen.getByTestId("viread-assistant-nav-yes"));
    expect(navState.routerPush).not.toHaveBeenCalled();

    const picker = await screen.findByTestId("viread-assistant-child-picker");
    expect(picker).toBeInTheDocument();
    const childBtn = screen.getByTestId(
      `viread-assistant-select-child-${CHILD_ONE.id}`,
    );
    expect(childBtn).toHaveTextContent("Bé An");
    expect(childBtn).toHaveTextContent("Lớp 2");

    await user.click(childBtn);
    expect(selectChildFromAssistantMock).toHaveBeenCalledWith(
      PARENT_ID,
      CHILD_ONE,
    );
    expect(navState.routerPush).toHaveBeenCalledWith("/books");
  });

  it("supports picking the 2nd child in multi-child families and switching active child via Đổi bé", async () => {
    navState.pathname = "/dashboard";
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: null,
      children: [CHILD_ONE, CHILD_TWO],
      selectedChild: null,
    });
    sendAssistantMessageMock
      .mockResolvedValueOnce({
        reply: "Mở Memory Game giúp bé ôn mặt chữ vui nhé!",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 9,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
        navigation_offer: {
          label: "Mở Memory Game lật thẻ",
          href: "/entertainment/memory-game",
          requires_child_selection: true,
        },
      })
      .mockResolvedValueOnce({
        reply: "Chuyển sang Kho sách cho bé nhé!",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 6,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
        navigation_offer: {
          label: "Mở Kho sách ViRead",
          href: "/books",
          requires_child_selection: true,
        },
      });

    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");

    await user.type(input, "Chơi Memory Game{Enter}");
    await user.click(await screen.findByTestId("viread-assistant-nav-yes"));
    await screen.findByTestId("viread-assistant-child-picker");

    await user.click(
      screen.getByTestId(`viread-assistant-select-child-${CHILD_TWO.id}`),
    );
    expect(selectChildFromAssistantMock).toHaveBeenCalledWith(
      PARENT_ID,
      CHILD_TWO,
    );
    expect(navState.routerPush).toHaveBeenCalledWith(
      "/entertainment/memory-game",
    );

    // Next offer shows active child badge for Bé Bình with "Đổi bé" trigger
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: CHILD_TWO.id,
      children: [CHILD_ONE, CHILD_TWO],
      selectedChild: CHILD_TWO,
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SELECTED_CHILD_LOCAL_EVENT));
    });

    await user.type(input, "Xem kho sách{Enter}");
    expect(
      await screen.findByTestId("viread-assistant-active-child-badge"),
    ).toHaveTextContent("Đang chọn bé: Bé Bình");

    await user.click(
      screen.getByTestId("viread-assistant-switch-child-trigger"),
    );
    await screen.findByTestId("viread-assistant-child-picker");
    await user.click(
      screen.getByTestId(`viread-assistant-select-child-${CHILD_ONE.id}`),
    );
    expect(navState.routerPush).toHaveBeenCalledWith("/books");
  });

  it("offers /children/new when parent has 0 child profiles", async () => {
    navState.pathname = "/dashboard";
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: null,
      children: [],
      selectedChild: null,
    });
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Mình mở Kho sách cho gia đình nhé!",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 5,
      cached: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
      navigation_offer: {
        label: "Mở Kho sách ViRead",
        href: "/books",
        requires_child_selection: true,
      },
    });

    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Mở kho sách{Enter}");
    await user.click(await screen.findByTestId("viread-assistant-nav-yes"));

    expect(
      await screen.findByTestId("viread-assistant-child-empty"),
    ).toBeInTheDocument();
    expect(navState.routerPush).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("viread-assistant-create-child-btn"));
    expect(navState.routerPush).toHaveBeenCalledWith("/children/new");
  });

  it("handles child context load failure with retry recovery and dashboard fallback", async () => {
    navState.pathname = "/dashboard";
    readAssistantChildContextMock
      .mockResolvedValueOnce({
        userId: PARENT_ID,
        selectedChildId: null,
        children: [],
        selectedChild: null,
        loadFailed: true,
      })
      .mockResolvedValueOnce({
        userId: PARENT_ID,
        selectedChildId: null,
        children: [],
        selectedChild: null,
        loadFailed: true,
      })
      .mockResolvedValueOnce({
        userId: PARENT_ID,
        selectedChildId: null,
        children: [CHILD_ONE],
        selectedChild: null,
      });

    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Mình mở Kho sách nhé!",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 5,
      cached: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
      navigation_offer: {
        label: "Mở Kho sách ViRead",
        href: "/books",
        requires_child_selection: true,
      },
    });

    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Mở kho sách{Enter}");
    await user.click(await screen.findByTestId("viread-assistant-nav-yes"));

    expect(
      await screen.findByTestId("viread-assistant-child-load-failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("viread-assistant-go-dashboard-select"),
    ).toBeInTheDocument();

    // Retry recovers to child picker
    await user.click(screen.getByTestId("viread-assistant-child-retry"));
    expect(readAssistantChildContextMock).toHaveBeenLastCalledWith({
      forceRefresh: true,
    });
    expect(
      await screen.findByTestId("viread-assistant-child-picker"),
    ).toBeInTheDocument();

    // Fallback link navigates to /dashboard?focus=child-selection
    await user.click(
      screen.getByTestId("viread-assistant-go-dashboard-select"),
    );
    expect(navState.routerPush).toHaveBeenCalledWith(
      "/dashboard?focus=child-selection",
    );
  });

  it("navigates immediately when child is already selected and intercepts missing-child Quick Action links", async () => {
    navState.pathname = "/dashboard";
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: CHILD_ONE.id,
      children: [CHILD_ONE],
      selectedChild: CHILD_ONE,
    });
    sendAssistantMessageMock
      .mockResolvedValueOnce({
        reply: "Mở Kho sách cho Bé An ngay nhé!",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 4,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
        navigation_offer: {
          label: "Mở Kho sách ViRead",
          href: "/books",
          requires_child_selection: true,
        },
      })
      .mockResolvedValueOnce({
        reply: "Bạn có thể bấm nút bên dưới để mở Memory Game.",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 4,
        cached: false,
        role_scope: "parent",
        quick_actions: [
          { label: "Mở Memory Game", href: "/entertainment/memory-game" },
          { label: "Trang Admin", href: "/admin/books" },
        ],
        suggested_prompts: [],
      });

    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");

    // 1. Child already selected -> clicking Có navigates immediately without picker
    await user.type(input, "Mở kho sách{Enter}");
    expect(
      await screen.findByTestId("viread-assistant-active-child-badge"),
    ).toHaveTextContent("Đang chọn bé: Bé An");
    await user.click(screen.getByTestId("viread-assistant-nav-yes"));
    expect(navState.routerPush).toHaveBeenCalledWith("/books");
    expect(
      screen.queryByTestId("viread-assistant-child-picker"),
    ).not.toBeInTheDocument();

    // 2. Child missing -> clicking Quick Action intercepts, blocks /admin/*, and opens picker
    navState.routerPush.mockReset();
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: null,
      children: [CHILD_ONE],
      selectedChild: null,
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SELECTED_CHILD_LOCAL_EVENT));
    });

    await user.type(input, "Trò chơi cho bé{Enter}");
    const quickLink = await screen.findByRole("link", {
      name: "Mở Memory Game",
    });
    expect(
      screen.queryByRole("link", { name: "Trang Admin" }),
    ).not.toBeInTheDocument();

    await user.click(quickLink);
    expect(navState.routerPush).not.toHaveBeenCalled();
    await screen.findByTestId("viread-assistant-child-picker");
    await user.click(
      screen.getByTestId(`viread-assistant-select-child-${CHILD_ONE.id}`),
    );
    expect(navState.routerPush).toHaveBeenCalledWith(
      "/entertainment/memory-game",
    );
  });

  it("enforces /reading/* exit confirmation before running child-selection gate", async () => {
    navState.pathname = "/reading/session-123";
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: null,
      children: [CHILD_ONE],
      selectedChild: null,
    });
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Bạn muốn quay lại Kho sách để chọn truyện khác?",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 5,
      cached: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
      navigation_offer: {
        label: "Mở Kho sách ViRead",
        href: "/books",
        requires_child_selection: true,
      },
    });

    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const panel = await screen.findByTestId("viread-assistant-panel");
    expect(panel.className).toContain("h-[min(360px,calc(100dvh-8.5rem))]");

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Đổi sách khác{Enter}");

    // Clicking Có on /reading/* shows exit confirmation first
    await user.click(await screen.findByTestId("viread-assistant-nav-yes"));
    expect(
      await screen.findByTestId("viread-assistant-reading-exit-confirm"),
    ).toBeInTheDocument();
    expect(navState.routerPush).not.toHaveBeenCalled();

    // Confirming exit STILL triggers child-selection gate before navigating!
    await user.click(screen.getByTestId("viread-assistant-nav-confirm-exit"));
    expect(navState.routerPush).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("viread-assistant-child-picker"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByTestId(`viread-assistant-select-child-${CHILD_ONE.id}`),
    );
    expect(navState.routerPush).toHaveBeenCalledWith("/books");
  });

  it("renders distinct role badges, isolates Admin/Parent/Guest routes and child-picker, and handles offline Supabase config safely", async () => {
    const user = userEvent.setup();

    // 1. Guest (/login) -> badge "Hỗ trợ Khách", blocks /dashboard offers & quick actions, never touches child profiles
    authState.throwOnCreate = true;
    navState.pathname = "/login";
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Vui lòng đăng nhập trước khi vào trang khách hàng.",
      source_tier: "tier_0_kb",
      provider_id: "viread_scope_guard",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 3,
      cached: false,
      role_scope: "public",
      quick_actions: [
        { label: "Tổng quan", href: "/dashboard" },
        { label: "Đăng nhập", href: "/login" },
      ],
      suggested_prompts: [],
      navigation_offer: {
        label: "Mở Tổng quan",
        href: "/dashboard",
        requires_child_selection: true,
      },
    });

    const { rerender } = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    expect(
      await screen.findByTestId("viread-assistant-role-badge"),
    ).toHaveTextContent("Hỗ trợ Khách");

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    await user.type(input, "Mở dashboard phụ huynh{Enter}");
    expect(
      await screen.findByText(/Vui lòng đăng nhập trước/),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-nav-card"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Tổng quan" }),
    ).not.toBeInTheDocument();
    expect(readAssistantChildContextMock).not.toHaveBeenCalled();

    // 2. Admin (/admin/books) -> badge "Hỗ trợ Quản trị", blocks customer /dashboard & /books, zero child-picker
    navState.pathname = "/admin/books";
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply: "Quản trị viên dùng Kho sách Quản trị, không mở trang phụ huynh.",
      source_tier: "tier_0_kb",
      provider_id: "viread_scope_guard",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 4,
      cached: false,
      role_scope: "admin",
      quick_actions: [
        { label: "Trang phụ huynh", href: "/dashboard" },
        { label: "Kho sách quản trị", href: "/admin/books" },
      ],
      suggested_prompts: [],
      navigation_offer: {
        label: "Mở Tổng quan phụ huynh",
        href: "/dashboard",
        requires_child_selection: true,
      },
    });

    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    expect(screen.getByTestId("viread-assistant-role-badge")).toHaveTextContent(
      "Hỗ trợ Quản trị",
    );
    // Guest history was cleared on role switch
    expect(
      screen.queryByText(/Vui lòng đăng nhập trước/),
    ).not.toBeInTheDocument();

    await user.type(input, "Mở dashboard khách hàng{Enter}");
    expect(
      await screen.findByText(/Quản trị viên dùng Kho sách Quản trị/),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-nav-card"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Trang phụ huynh" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-active-child-badge"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-child-picker"),
    ).not.toBeInTheDocument();
    expect(readAssistantChildContextMock).not.toHaveBeenCalled();

    // 3. Parent (/dashboard) -> badge "Hỗ trợ Phụ huynh", blocks /admin/* and handles off-topic ViRead-only refusal
    navState.pathname = "/dashboard";
    sendAssistantMessageMock.mockResolvedValueOnce({
      reply:
        "Trợ lý ViRead chỉ hỗ trợ các tính năng đọc sách và học tập trong ViRead.",
      source_tier: "tier_0_kb",
      provider_id: "viread_domain_guard",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 2,
      cached: false,
      role_scope: "parent",
      quick_actions: [{ label: "Mở Kho sách", href: "/books" }],
      suggested_prompts: [],
    });

    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    expect(screen.getByTestId("viread-assistant-role-badge")).toHaveTextContent(
      "Hỗ trợ Phụ huynh",
    );
    await user.type(input, "Giá vàng hôm nay bao nhiêu?{Enter}");
    expect(
      await screen.findByText(/chỉ hỗ trợ các tính năng đọc sách/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Hỏi AI sâu hơn/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("viread-assistant-retry-ai"),
    ).not.toBeInTheDocument();
  });

  it("preserves history within same user+role, resets history on customer switch/logout, and aborts in-flight requests on role switch", async () => {
    const user = userEvent.setup();
    let capturedAbortSignal: AbortSignal | undefined;

    sendAssistantMessageMock
      .mockResolvedValueOnce({
        reply: "Phản hồi riêng cho phụ huynh A.",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 4,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
      })
      .mockImplementationOnce((_payload, options) => {
        capturedAbortSignal = options?.signal;
        return new Promise(() => {
          // Never resolves: simulates slow request aborted on role switch.
        });
      });

    const { rerender } = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");

    await user.type(input, "Câu hỏi của phụ huynh A{Enter}");
    expect(
      await screen.findByText("Phản hồi riêng cho phụ huynh A."),
    ).toBeInTheDocument();

    // Navigating /dashboard -> /books (same user, same parent role) preserves conversation!
    navState.pathname = "/books";
    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    expect(
      screen.getByText("Phản hồi riêng cho phụ huynh A."),
    ).toBeInTheDocument();

    // Switching customer account (PARENT_ID -> OTHER_PARENT_ID) immediately clears history!
    await act(async () => {
      authState.emit("SIGNED_IN", { user: { id: OTHER_PARENT_ID } });
    });
    expect(
      screen.queryByText("Phản hồi riêng cho phụ huynh A."),
    ).not.toBeInTheDocument();

    // Start an in-flight request in parent scope, then switch to admin scope -> aborts & clears!
    await user.type(input, "Câu hỏi đang chờ của phụ huynh B{Enter}");
    expect(
      await screen.findByTestId("viread-assistant-loading-card"),
    ).toBeInTheDocument();
    expect(capturedAbortSignal?.aborted).toBe(false);

    navState.pathname = "/admin/health";
    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );

    expect(capturedAbortSignal?.aborted).toBe(true);
    expect(
      screen.queryByTestId("viread-assistant-loading-card"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Câu hỏi đang chờ của phụ huynh B"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("viread-assistant-role-badge")).toHaveTextContent(
      "Hỗ trợ Quản trị",
    );
  });

  it("forwards selectedChildId only in parent scope and strips it in public and admin scopes", async () => {
    const user = userEvent.setup();
    readAssistantChildContextMock.mockResolvedValue({
      userId: PARENT_ID,
      selectedChildId: CHILD_ONE.id,
      children: [CHILD_ONE],
      selectedChild: CHILD_ONE,
    });
    sendAssistantMessageMock.mockResolvedValue({
      reply: "Đã kiểm tra ngữ cảnh.",
      source_tier: "tier_0_kb",
      provider_id: "viread_kb",
      model_id: "grounded-viread-kb-v1",
      bandwidth_applied: "high",
      latency_ms: 5,
      cached: false,
      live_grounded: false,
      role_scope: "parent",
      quick_actions: [],
      suggested_prompts: [],
    });

    navState.pathname = "/dashboard";
    const { rerender } = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");

    await waitFor(() =>
      expect(readAssistantChildContextMock).toHaveBeenCalled(),
    );
    await user.type(input, "Bé yếu từ nào?{Enter}");

    await waitFor(() =>
      expect(sendAssistantMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedChildId: CHILD_ONE.id,
        }),
        expect.any(Object),
      ),
    );

    // Switch to admin scope -> selectedChildId must be null
    navState.pathname = "/admin/health";
    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    await user.type(input, "Trạng thái OCR?{Enter}");
    await waitFor(() =>
      expect(sendAssistantMessageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          current_path: "/admin/health",
          selectedChildId: null,
        }),
        expect.any(Object),
      ),
    );

    // Switch to public scope -> selectedChildId must be null
    navState.pathname = "/login";
    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    await user.type(input, "Cách đăng nhập?{Enter}");
    await waitFor(() =>
      expect(sendAssistantMessageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          current_path: "/login",
          selectedChildId: null,
        }),
        expect.any(Object),
      ),
    );
  });

  it("renders liveGrounded badge, Copy button with copied state, and Helpful/Not-Helpful feedback controls", async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    sendAssistantMessageMock
      .mockResolvedValueOnce({
        reply: "Bé An cần luyện thêm từ **nghiêng**.",
        source_tier: "tier_0_kb",
        provider_id: "viread_live_parent",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 9,
        cached: false,
        live_grounded: true,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
      })
      .mockResolvedValueOnce({
        reply: "Hệ thống đang có 2 tác vụ OCR chờ xử lý.",
        source_tier: "tier_1_cloud",
        provider_id: "gemini_primary",
        model_id: "gemini-3.5-flash-lite",
        bandwidth_applied: "high",
        latency_ms: 210,
        cached: false,
        live_grounded: true,
        role_scope: "admin",
        quick_actions: [],
        suggested_prompts: [],
      })
      .mockResolvedValueOnce({
        reply: "Phân tích sâu từ AI cho quản trị viên.",
        source_tier: "tier_2_ollama",
        provider_id: "ollama_local",
        model_id: "qwen3-vl:4b-instruct-q4_K_M",
        bandwidth_applied: "high",
        latency_ms: 600,
        cached: false,
        live_grounded: true,
        role_scope: "admin",
        quick_actions: [],
        suggested_prompts: [],
      })
      .mockResolvedValueOnce({
        reply: "Trợ lý ViRead chỉ hỗ trợ về ViRead.",
        source_tier: "tier_0_kb",
        provider_id: "viread_domain_guard",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 2,
        cached: false,
        live_grounded: false,
        role_scope: "admin",
        quick_actions: [],
        suggested_prompts: [],
      });

    navState.pathname = "/dashboard";
    const { rerender } = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    const input = await screen.findByLabelText("Nhập câu hỏi về ViRead");

    await user.type(input, "Bé yếu từ nào?{Enter}");
    expect(
      await screen.findByTestId("viread-assistant-live-badge"),
    ).toHaveTextContent("Dữ liệu thực tế của bạn");

    const copyBtn = screen.getByTestId("viread-assistant-copy-btn");
    await user.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalledWith(
      "Bé An cần luyện thêm từ **nghiêng**.",
    );
    expect(copyBtn).toHaveTextContent("Đã sao chép");

    const upBtn = screen.getByTestId("viread-assistant-feedback-up");
    await user.click(upBtn);
    expect(upBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Cảm ơn phản hồi của bạn")).toBeInTheDocument();

    // Switch to admin -> liveAdminBadge + down feedback reveals 1-tap "Hỏi AI sâu hơn"
    navState.pathname = "/admin/tasks";
    rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );

    await user.type(input, "Thống kê OCR hiện tại?{Enter}");
    expect(
      await screen.findByTestId("viread-assistant-live-badge"),
    ).toHaveTextContent("Thống kê hệ thống trực tiếp");
    expect(
      screen.queryByRole("button", { name: /Hỏi AI sâu hơn/i }),
    ).not.toBeInTheDocument();

    const downBtn = screen.getByTestId("viread-assistant-feedback-down");
    await user.click(downBtn);
    expect(downBtn).toHaveAttribute("aria-pressed", "true");

    const deeperBtn = screen.getByRole("button", { name: /Hỏi AI sâu hơn/i });
    await user.click(deeperBtn);
    await waitFor(() =>
      expect(sendAssistantMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Thống kê OCR hiện tại?",
          force_llm: true,
        }),
        expect.any(Object),
      ),
    );
    expect(
      await screen.findByText("Phân tích sâu từ AI cho quản trị viên."),
    ).toBeInTheDocument();

    // Domain guard refusal must NOT expose "Hỏi AI sâu hơn" even after thumbs-down
    await user.type(input, "Giá bitcoin hôm nay?{Enter}");
    expect(
      await screen.findByText("Trợ lý ViRead chỉ hỗ trợ về ViRead."),
    ).toBeInTheDocument();
    const downBtns = screen.getAllByTestId("viread-assistant-feedback-down");
    await user.click(downBtns[downBtns.length - 1]);
    expect(
      screen.queryAllByRole("button", { name: /Hỏi AI sâu hơn/i }),
    ).toHaveLength(1);
  });

  it("hides voice input button when SpeechRecognition is absent and supports voice transcript + auto-stop when supported", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel");

    expect(
      screen.queryByTestId("viread-assistant-voice-btn"),
    ).not.toBeInTheDocument();
    unmount();

    const instances: Array<{
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: ((event: unknown) => void) | null;
      onerror: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    }> = [];

    class MockSpeechRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      writable: true,
      value: MockSpeechRecognition,
    });

    const rendered = renderWidget();
    await user.click(screen.getByTestId("viread-assistant-launcher"));
    await screen.findByTestId("viread-assistant-panel");

    const voiceBtn = screen.getByTestId("viread-assistant-voice-btn");
    expect(voiceBtn).toHaveAttribute("aria-pressed", "false");

    await user.click(voiceBtn);
    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe("vi-VN");
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(voiceBtn).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      instances[0].onresult?.({
        results: [[{ transcript: "Bé hôm nay nên đọc sách gì" }]],
      });
    });

    const input = screen.getByLabelText("Nhập câu hỏi về ViRead");
    expect(input).toHaveValue("Bé hôm nay nên đọc sách gì");

    // Role change automatically stops active SpeechRecognition
    navState.pathname = "/admin/health";
    rendered.rerender(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>,
    );
    expect(instances[0].stop).toHaveBeenCalled();
    expect(voiceBtn).toHaveAttribute("aria-pressed", "false");
    rendered.unmount();
    void rerender;
  });

  it("persists up to 12 sanitized messages in scoped sessionStorage, drops corrupted entries, hydrates cleanly, and purges on clear/switch/logout", async () => {
    const scopeKey = `viread:assistant:history:v1:parent:${PARENT_ID}`;
    const seededItems: unknown[] = [];
    for (let i = 1; i <= 13; i += 1) {
      seededItems.push({
        id: `msg-${i}`,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `Tin nhắn lịch sử ${i}`,
        roleScope: "parent",
      });
    }
    seededItems.push({ invalid: true });
    seededItems.push({
      id: "cross-role",
      role: "assistant",
      content: "Rò rỉ admin",
      roleScope: "admin",
    });
    seededItems.push({
      id: "jwt-leak",
      role: "user",
      content:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturetoken123",
    });
    window.sessionStorage.setItem(scopeKey, JSON.stringify(seededItems));

    // Verify SSR HTML has zero messages -> zero hydration mismatch
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const element = (
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <ViReadAssistantWidget />
      </I18nProvider>
    );

    const ssrHtml = renderToString(element);
    const container = document.createElement("div");
    container.innerHTML = ssrHtml;
    document.body.appendChild(container);

    const consoleErrors: unknown[][] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        consoleErrors.push(args);
      });

    const user = userEvent.setup();
    let root: ReturnType<typeof hydrateRoot> | null = null;
    try {
      await act(async () => {
        root = hydrateRoot(container, element);
      });
      expect(consoleErrors).toEqual([]);

      await user.click(
        within(container).getByTestId("viread-assistant-launcher"),
      );
      const panel = await within(container).findByTestId(
        "viread-assistant-panel",
        undefined,
        { timeout: 5000 },
      );

      // Keeps latest 12 valid messages (msg-2..msg-13), drops msg-1, corrupted, cross-role, and Bearer JWT!
      await waitFor(() =>
        expect(
          within(panel).getByText("Tin nhắn lịch sử 13"),
        ).toBeInTheDocument(),
      );
      expect(
        within(panel).queryByText("Tin nhắn lịch sử 1"),
      ).not.toBeInTheDocument();
      expect(within(panel).queryByText("Rò rỉ admin")).not.toBeInTheDocument();
      expect(within(panel).queryByText(/Bearer/)).not.toBeInTheDocument();

      // Clear removes active sessionStorage key immediately
      await user.click(within(panel).getByTestId("viread-assistant-clear"));
      expect(window.sessionStorage.getItem(scopeKey)).toBeNull();

      // Send a new message -> persisted, then purged on SIGNED_OUT
      sendAssistantMessageMock.mockResolvedValueOnce({
        reply: "Hướng dẫn lưu trong sessionStorage.",
        source_tier: "tier_0_kb",
        provider_id: "viread_kb",
        model_id: "grounded-viread-kb-v1",
        bandwidth_applied: "high",
        latency_ms: 4,
        cached: false,
        live_grounded: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
      });
      const input = within(panel).getByLabelText("Nhập câu hỏi về ViRead");
      await user.type(input, "Kiểm tra lưu lịch sử{Enter}");
      await waitFor(() =>
        expect(window.sessionStorage.getItem(scopeKey)).toContain(
          "Hướng dẫn lưu trong sessionStorage.",
        ),
      );

      await act(async () => {
        authState.emit("SIGNED_OUT", null);
      });
      expect(window.sessionStorage.getItem(scopeKey)).toBeNull();
      expect(
        within(panel).queryByText("Hướng dẫn lưu trong sessionStorage."),
      ).not.toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });
});
