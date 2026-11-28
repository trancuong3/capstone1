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
    expect(offlineReply.quick_actions[0]?.href).toBe("/device-permissions");

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
});
