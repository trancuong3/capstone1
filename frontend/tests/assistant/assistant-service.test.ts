import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantRateLimitError,
  sendAssistantMessage,
} from "@/lib/api/assistant-service";
import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import {
  detectNetworkBandwidth,
  resolveOfflineAssistantReply,
  resolvePageGuide,
} from "@/lib/assistant/page-guides";
import { isSafeAssistantNavigationHref } from "@/lib/assistant/route-helpers";

vi.mock("@/lib/api/browser-auth", () => ({
  getBrowserAccessToken: vi.fn().mockRejectedValue(new Error("NO_SESSION")),
  invalidateBrowserTokenCache: vi.fn(),
}));

describe("assistant-service and bandwidth detection", () => {
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:8000";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("classifies 2g / saveData as low bandwidth and 3g as medium bandwidth", () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: { effectiveType: "2g", downlink: 0.4, saveData: false },
    });
    expect(detectNetworkBandwidth().profile).toBe("low");

    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g", downlink: 10, saveData: true },
    });
    expect(detectNetworkBandwidth().profile).toBe("low");

    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: { effectiveType: "3g", downlink: 2.0, saveData: false },
    });
    expect(detectNetworkBandwidth().profile).toBe("medium");

    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g", downlink: 15, rtt: 50, saveData: false },
    });
    expect(detectNetworkBandwidth().profile).toBe("high");

    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g", downlink: 10, rtt: 500, saveData: false },
    });
    expect(detectNetworkBandwidth().profile).toBe("low");
  });

  it("falls back cleanly to offline quick guide when offline or fetch fails", async () => {
    const offlineReply = await sendAssistantMessage(
      {
        message: "Micro không nhận giọng bé",
        current_path: "/reading/123",
        locale: "vi",
        bandwidth_profile: "low",
        history: [],
      },
      { online: false },
    );

    expect(offlineReply.source_tier).toBe("offline");
    expect(offlineReply.quick_actions[0]?.href).toBe("/reading-preparation");
    expect(offlineReply.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/reading-preparation",
        requires_child_selection: true,
        scenario_id: "mic_camera_permissions",
      }),
    );

    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const networkErrReply = await sendAssistantMessage(
      {
        message: "Quét sách giấy bị mờ",
        current_path: "/book-scanner",
        locale: "vi",
        bandwidth_profile: "medium",
        history: [],
      },
      { online: true },
    );
    expect(networkErrReply.source_tier).toBe("offline");
    expect(networkErrReply.reply).toContain("Quét sách");
  });

  it("throws AssistantRateLimitError on HTTP 429 and rejects external quick_action hrefs", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "rate limited" }), {
        status: 429,
        headers: { "Retry-After": "12" },
      }),
    );

    await expect(
      sendAssistantMessage(
        {
          message: "ViRead là gì?",
          current_path: "/login",
          locale: "vi",
          bandwidth_profile: "high",
          history: [],
        },
        { online: true },
      ),
    ).rejects.toBeInstanceOf(AssistantRateLimitError);

    // Malformed external href in payload must fail Zod validation and degrade safely.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: "Unsafe link",
          source_tier: "tier_1_cloud",
          provider_id: "gemini_primary",
          model_id: "gemini-3.5-flash-lite",
          bandwidth_applied: "high",
          latency_ms: 120,
          cached: false,
          role_scope: "public",
          quick_actions: [{ label: "Bad", href: "https://evil.example" }],
          suggested_prompts: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const sanitized = await sendAssistantMessage(
      {
        message: "Quên mật khẩu",
        current_path: "/login",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
      },
      { online: true },
    );
    expect(sanitized.source_tier).toBe("offline");
    expect(sanitized.quick_actions.every((a) => a.href.startsWith("/"))).toBe(
      true,
    );
  });

  it("returns localized contextual page guides, keeps /admin/login strictly public, and filters public offline actions safely", () => {
    const adminGuide = resolvePageGuide("/admin/health", "en");
    expect(adminGuide.title).toBe("Operations Health");
    expect(adminGuide.prompts).toHaveLength(3);

    const adminLoginGuide = resolvePageGuide("/admin/login", "vi");
    expect(adminLoginGuide.title).toBe("Đăng nhập Quản trị");
    expect(
      adminLoginGuide.actions.every((a) => !a.href.startsWith("/admin")),
    ).toBe(true);
    expect(adminLoginGuide.greeting).not.toContain("OCR");

    const adminLoginOffline = resolveOfflineAssistantReply(
      "Quên mật khẩu",
      "/admin/login",
      "vi",
      "low",
    );
    expect(adminLoginOffline.role_scope).toBe("public");
    expect(
      adminLoginOffline.quick_actions.every(
        (a) => !a.href.startsWith("/admin"),
      ),
    ).toBe(true);

    const publicOffline = resolveOfflineAssistantReply(
      "Micro không nghe",
      "/login",
      "vi",
      "low",
    );
    expect(publicOffline.role_scope).toBe("public");
    expect(
      publicOffline.quick_actions.every((a) => !a.href.startsWith("/admin")),
    ).toBe(true);
  });

  it("enforces strict own-scope navigation allowlists, retries 401 refresh once, and strips unsafe navigation offers", async () => {
    expect(
      isSafeAssistantNavigationHref(
        "/device-permissions",
        "/dashboard",
        "parent",
      ),
    ).toBe(false);
    expect(
      isSafeAssistantNavigationHref("/settings", "/dashboard", "parent"),
    ).toBe(true);
    expect(
      isSafeAssistantNavigationHref("/settings", "/settings", "parent"),
    ).toBe(false);
    expect(
      isSafeAssistantNavigationHref("/admin/health", "/dashboard", "parent"),
    ).toBe(false);
    expect(
      isSafeAssistantNavigationHref("/children/123", "/dashboard", "parent"),
    ).toBe(false);
    expect(isSafeAssistantNavigationHref("/dashboard", "/", "public")).toBe(
      false,
    );
    expect(
      isSafeAssistantNavigationHref("//evil.example", "/dashboard", "parent"),
    ).toBe(false);

    vi.mocked(getBrowserAccessToken)
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            reply:
              "Bạn có muốn chuyển đến trang Cài đặt để đổi mật khẩu không?",
            source_tier: "tier_0_kb",
            provider_id: "viread_kb",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: "high",
            latency_ms: 15,
            cached: false,
            role_scope: "parent",
            quick_actions: [{ label: "Cài đặt", href: "/settings" }],
            suggested_prompts: [],
            navigation_offer: {
              label: "Đi đến Cài đặt",
              href: "/settings",
              reason: "Đổi mật khẩu tài khoản bạn.",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    global.fetch = fetchMock;

    const okRes = await sendAssistantMessage(
      {
        message: "Tôi muốn đổi mật khẩu",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
      },
      { online: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invalidateBrowserTokenCache)).toHaveBeenCalled();
    expect(okRes.navigation_offer?.href).toBe("/settings");
    expect(okRes.navigation_offer?.requires_child_selection).toBe(false);
    expect(okRes.navigation_offer?.scenario_id).toBeNull();

    // Preserves requires_child_selection & scenario_id when backend provides them.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: "Bạn có muốn mở Memory Game cho bé không?",
          source_tier: "tier_0_kb",
          provider_id: "viread_kb",
          model_id: "grounded-viread-kb-v1",
          bandwidth_applied: "high",
          latency_ms: 10,
          cached: false,
          role_scope: "parent",
          quick_actions: [
            { label: "Memory Game", href: "/entertainment/memory-game" },
          ],
          suggested_prompts: [],
          navigation_offer: {
            label: "Đi đến Memory Game",
            href: "/entertainment/memory-game",
            reason: "Chơi lật thẻ cùng bé.",
            requires_child_selection: true,
            scenario_id: "game_suggestions",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const childGateRes = await sendAssistantMessage(
      {
        message: "Mở Memory Game cho bé",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
      },
      { online: true },
    );
    expect(childGateRes.navigation_offer).toEqual({
      label: "Đi đến Memory Game",
      href: "/entertainment/memory-game",
      reason: "Chơi lật thẻ cùng bé.",
      requires_child_selection: true,
      scenario_id: "game_suggestions",
    });

    // Backend returning a disallowed admin navigation_offer to parent scope must be stripped cleanly.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: "Test scope",
          source_tier: "tier_1_cloud",
          provider_id: "groq_qwen",
          model_id: "qwen",
          bandwidth_applied: "high",
          latency_ms: 50,
          cached: false,
          role_scope: "parent",
          quick_actions: [],
          suggested_prompts: [],
          navigation_offer: {
            label: "Admin",
            href: "/admin/health",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const strippedRes = await sendAssistantMessage(
      {
        message: "Test",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
      },
      { online: true },
    );
    expect(strippedRes.navigation_offer).toBeNull();
  });

  it("covers rich offline scenarios, removes legacy /device-permissions traps, and enforces scope guard", () => {
    const whyChild = resolveOfflineAssistantReply(
      "Vì sao phải chọn hồ sơ bé trước khi đọc?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(whyChild.reply).toContain("lớp (1–5)");

    const switchSiblings = resolveOfflineAssistantReply(
      "Nhà có 2 bé thì chuyển bé thế nào?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(switchSiblings.navigation_offer?.href).toBe("/children");
    expect(switchSiblings.navigation_offer?.requires_child_selection).toBe(
      false,
    );

    const slowReader = resolveOfflineAssistantReply(
      "Bé đọc chậm và hay đánh vần thì chỉnh sao?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(slowReader.reply).toContain("0.85x");
    expect(slowReader.navigation_offer?.href).toBe("/reports/difficult-words");
    expect(slowReader.navigation_offer?.scenario_id).toBe(
      "slow_reader_support",
    );

    const games = resolveOfflineAssistantReply(
      "Bé lười đọc có trò chơi gì vui?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(games.navigation_offer?.href).toBe("/entertainment");
    expect(games.navigation_offer?.requires_child_selection).toBe(true);
    expect(games.navigation_offer?.scenario_id).toBe("game_suggestions");

    const scannerVsMyBooks = resolveOfflineAssistantReply(
      "Khác nhau giữa Quét sách và Sách của tôi?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(scannerVsMyBooks.reply).toContain("/book-scanner");
    expect(scannerVsMyBooks.reply).toContain("/my-books");

    const weeklyReminders = resolveOfflineAssistantReply(
      "Cách đặt lịch email nhắc đọc hàng tuần?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(weeklyReminders.navigation_offer?.href).toBe("/reading-management");
    expect(weeklyReminders.navigation_offer?.requires_child_selection).toBe(
      false,
    );

    const lowBw = resolveOfflineAssistantReply(
      "Mạng 3G yếu bị lag thì bật tiết kiệm dữ liệu ở đâu?",
      "/dashboard",
      "vi",
      "low",
    );
    expect(lowBw.reply).toContain("Tiết kiệm");

    const offlineMode = resolveOfflineAssistantReply(
      "Khi mất mạng ngoại tuyến ViRead làm được gì?",
      "/dashboard",
      "vi",
      "low",
    );
    expect(offlineMode.reply).toContain("Hàng chờ OCR");

    const adminProbe = resolveOfflineAssistantReply(
      "Mở /admin/health giúp tôi",
      "/dashboard",
      "vi",
      "high",
    );
    expect(adminProbe.provider_id).toBe("viread_scope_guard");
    expect(adminProbe.navigation_offer).toBeNull();

    const otherParentProbe = resolveOfflineAssistantReply(
      "Xem dữ liệu tài khoản phụ huynh khác",
      "/dashboard",
      "vi",
      "high",
    );
    expect(otherParentProbe.provider_id).toBe("viread_scope_guard");
    expect(otherParentProbe.navigation_offer).toBeNull();

    const prepGuide = resolvePageGuide("/reading-preparation", "vi");
    expect(
      prepGuide.actions.some((a) => a.href === "/device-permissions"),
    ).toBe(false);
  });
});
