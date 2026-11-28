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
  normalizeQuery,
  resolveOfflineAssistantReply,
  resolvePageGuide,
} from "@/lib/assistant/page-guides";
import {
  ADMIN_ASSISTANT_NAV_ALLOWLIST,
  hasMobileBottomNavPath,
  isSafeAssistantNavigationHref,
  isSafeAssistantQuickActionHref,
  PARENT_ASSISTANT_NAV_ALLOWLIST,
  PUBLIC_ASSISTANT_NAV_ALLOWLIST,
} from "@/lib/assistant/route-helpers";

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

  it("keeps public, parent, and admin allowlists 100% disjoint across navigation and quick actions", () => {
    for (const href of PUBLIC_ASSISTANT_NAV_ALLOWLIST) {
      expect(PARENT_ASSISTANT_NAV_ALLOWLIST.has(href)).toBe(false);
      expect(ADMIN_ASSISTANT_NAV_ALLOWLIST.has(href)).toBe(false);
    }
    for (const href of PARENT_ASSISTANT_NAV_ALLOWLIST) {
      expect(PUBLIC_ASSISTANT_NAV_ALLOWLIST.has(href)).toBe(false);
      expect(ADMIN_ASSISTANT_NAV_ALLOWLIST.has(href)).toBe(false);
    }
    expect(PUBLIC_ASSISTANT_NAV_ALLOWLIST.has("/admin/login")).toBe(false);
    expect(PARENT_ASSISTANT_NAV_ALLOWLIST.has("/achievements")).toBe(true);
    expect(PARENT_ASSISTANT_NAV_ALLOWLIST.has("/learning-train")).toBe(true);
    expect(
      Array.from(ADMIN_ASSISTANT_NAV_ALLOWLIST).every(
        (href) => href === "/admin" || href.startsWith("/admin/"),
      ),
    ).toBe(true);

    // Parent cannot use admin or public auth links in nav or quick actions.
    expect(
      isSafeAssistantQuickActionHref("/login", "/dashboard", "parent"),
    ).toBe(false);
    expect(
      isSafeAssistantQuickActionHref("/admin/books", "/dashboard", "parent"),
    ).toBe(false);
    expect(
      isSafeAssistantNavigationHref("/login", "/dashboard", "parent"),
    ).toBe(false);

    // Admin cannot use parent/customer or public guest auth links.
    expect(isSafeAssistantNavigationHref("/dashboard", "/admin", "admin")).toBe(
      false,
    );
    expect(isSafeAssistantNavigationHref("/books", "/admin", "admin")).toBe(
      false,
    );
    expect(isSafeAssistantNavigationHref("/login", "/admin", "admin")).toBe(
      false,
    );
    expect(
      isSafeAssistantQuickActionHref("/dashboard", "/admin/books", "admin"),
    ).toBe(false);
    expect(
      isSafeAssistantQuickActionHref("/register", "/admin/books", "admin"),
    ).toBe(false);
    expect(
      isSafeAssistantQuickActionHref("/admin/login", "/admin/books", "admin"),
    ).toBe(false);
    expect(
      isSafeAssistantNavigationHref("/admin/books", "/admin/health", "admin"),
    ).toBe(true);

    // Public cannot use parent or admin links.
    expect(
      isSafeAssistantQuickActionHref("/dashboard", "/login", "public"),
    ).toBe(false);
    expect(
      isSafeAssistantQuickActionHref("/admin/login", "/login", "public"),
    ).toBe(false);

    // Mobile bottom nav check for /achievements and /learning-train.
    expect(hasMobileBottomNavPath("/achievements")).toBe(true);
    expect(hasMobileBottomNavPath("/learning-train")).toBe(true);
    expect(hasMobileBottomNavPath("/reading/1")).toBe(false);
    expect(hasMobileBottomNavPath("/children/new")).toBe(false);
    expect(hasMobileBottomNavPath("/books")).toBe(false);
    expect(hasMobileBottomNavPath("/admin/login")).toBe(false);
  });

  it("filters cross-scope quick_actions and normalizes spoofed role_scope in API responses", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: "Cross-scope payload",
          source_tier: "tier_1_cloud",
          provider_id: "gemini_primary",
          model_id: "gemini-3.5-flash-lite",
          bandwidth_applied: "high",
          latency_ms: 25,
          cached: false,
          role_scope: "parent",
          quick_actions: [
            { label: "Admin Books", href: "/admin/books" },
            { label: "Parent Dashboard", href: "/dashboard" },
            { label: "Guest Login", href: "/login" },
          ],
          suggested_prompts: [],
          navigation_offer: {
            label: "Open Parent Dashboard",
            href: "/dashboard",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const adminNormalized = await sendAssistantMessage(
      {
        message: "Mở kho sách",
        current_path: "/admin/health",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
      },
      { online: true },
    );

    expect(adminNormalized.role_scope).toBe("admin");
    expect(adminNormalized.quick_actions).toEqual([
      { label: "Admin Books", href: "/admin/books" },
    ]);
    expect(adminNormalized.navigation_offer).toBeNull();
  });

  it("provides contextual guides for new parent/admin routes and enforces 4-way scope + ViRead-only domain guards", () => {
    // New Parent guides
    const achievementsGuide = resolvePageGuide("/achievements", "vi");
    expect(achievementsGuide.title).toBe("Vườn Âm Vị & Huy hiệu");
    expect(achievementsGuide.actions.map((a) => a.href)).toEqual([
      "/learning-train",
      "/reports",
    ]);

    const trainGuide = resolvePageGuide("/learning-train", "en");
    expect(trainGuide.title).toBe("5-Minute Reading Train");
    expect(trainGuide.actions.map((a) => a.href)).toEqual([
      "/achievements",
      "/reading-preparation",
    ]);

    // New Admin guides + /admin/login with zero workspace or parent links
    for (const adminRoute of [
      "/admin/books",
      "/admin/karaoke",
      "/admin/parents",
      "/admin/tasks",
      "/admin/audit-logs",
    ]) {
      const guide = resolvePageGuide(adminRoute, "vi");
      expect(guide.prompts).toHaveLength(3);
      expect(guide.actions.every((a) => a.href.startsWith("/admin/"))).toBe(
        true,
      );
    }
    const adminLoginGuide = resolvePageGuide("/admin/login", "vi");
    expect(adminLoginGuide.actions).toEqual([]);

    // 4-way isolation in offline replies
    const adminToCustomer = resolveOfflineAssistantReply(
      "Mở /dashboard cho phụ huynh",
      "/admin/books",
      "vi",
      "high",
    );
    expect(adminToCustomer.provider_id).toBe("viread_scope_guard");
    expect(adminToCustomer.navigation_offer).toBeNull();

    const adminToGuest = resolveOfflineAssistantReply(
      "Mở trang /login của phụ huynh",
      "/admin/books",
      "vi",
      "high",
    );
    expect(adminToGuest.provider_id).toBe("viread_scope_guard");
    expect(adminToGuest.navigation_offer).toBeNull();

    const adminOtherUser = resolveOfflineAssistantReply(
      "Xem dữ liệu tài khoản phụ huynh khác",
      "/admin/parents",
      "vi",
      "high",
    );
    expect(adminOtherUser.provider_id).toBe("viread_scope_guard");
    expect(adminOtherUser.navigation_offer).toBeNull();

    const adminParentsQuery = resolveOfflineAssistantReply(
      "Xem trang quản lý phụ huynh",
      "/admin/health",
      "vi",
      "high",
    );
    expect(adminParentsQuery.provider_id).toBe("viread_offline_guide");
    expect(adminParentsQuery.navigation_offer?.href).toBe("/admin/parents");

    const guestToCustomer = resolveOfflineAssistantReply(
      "Mở /dashboard xem báo cáo",
      "/login",
      "vi",
      "high",
    );
    expect(guestToCustomer.provider_id).toBe("viread_scope_guard");
    expect(guestToCustomer.navigation_offer).toBeNull();
    expect(
      guestToCustomer.quick_actions.every((a) =>
        PUBLIC_ASSISTANT_NAV_ALLOWLIST.has(a.href),
      ),
    ).toBe(true);

    const parentToAdminLogin = resolveOfflineAssistantReply(
      "Mở /admin/login giúp tôi",
      "/dashboard",
      "vi",
      "high",
    );
    expect(parentToAdminLogin.provider_id).toBe("viread_scope_guard");
    expect(parentToAdminLogin.navigation_offer).toBeNull();

    // Deterministic ViRead-only off-topic domain guard
    for (const offTopicPrompt of [
      "Thời tiết Hà Nội hôm nay thế nào?",
      "Giá cổ phiếu và bitcoin hôm nay?",
      "Giải phương trình bậc 2 giúp tôi",
      "Viết code Python đọc file CSV",
      "Cách nấu phở bò ngon",
      "Kê đơn thuốc trị ho cho bé",
      "Tư vấn pháp luật lao động",
    ]) {
      const refused = resolveOfflineAssistantReply(
        offTopicPrompt,
        "/dashboard",
        "vi",
        "high",
      );
      expect(refused.provider_id).toBe("viread_domain_guard");
      expect(refused.navigation_offer).toBeNull();
    }

    // Greetings & missing ViRead feature coverage remain allowed
    const greeting = resolveOfflineAssistantReply(
      "Xin chào",
      "/dashboard",
      "vi",
      "high",
    );
    expect(greeting.provider_id).toBe("viread_offline_guide");

    const phonemeGarden = resolveOfflineAssistantReply(
      "Mở Vườn Âm Vị và huy hiệu của bé",
      "/dashboard",
      "vi",
      "high",
    );
    expect(phonemeGarden.provider_id).toBe("viread_offline_guide");
    expect(phonemeGarden.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/achievements",
        requires_child_selection: true,
        scenario_id: "phoneme_garden_achievements",
      }),
    );

    const learningTrain = resolveOfflineAssistantReply(
      "Chuyến Tàu Đọc 5 Phút cho bé",
      "/dashboard",
      "vi",
      "high",
    );
    expect(learningTrain.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/learning-train",
        requires_child_selection: true,
        scenario_id: "five_minute_learning_train",
      }),
    );

    const storyWeaver = resolveOfflineAssistantReply(
      "Family StoryWeaver tạo truyện thế nào?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(storyWeaver.reply).toContain("StoryWeaver");

    const duet = resolveOfflineAssistantReply(
      "Chế độ đọc đôi Duet Reading là gì?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(duet.reply).toContain("Duet");

    const wasmTts = resolveOfflineAssistantReply(
      "WASM offline TTS và giọng cô giáo AI",
      "/dashboard",
      "vi",
      "high",
    );
    expect(wasmTts.reply).toContain("WASM");

    const pinLock = resolveOfflineAssistantReply(
      "Mã PIN phụ huynh 4 số khóa gì?",
      "/dashboard",
      "vi",
      "high",
    );
    expect(pinLock.reply).toContain("4");
  });

  it("forwards selected_child_id ONLY in parent scope and parses live_grounded cleanly", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          reply: "Bé An đã đọc 3 buổi trong 7 ngày qua.",
          source_tier: "tier_0_kb",
          provider_id: "viread_live_parent",
          model_id: "grounded-viread-live-v1",
          bandwidth_applied: "high",
          latency_ms: 18,
          cached: false,
          live_grounded: true,
          role_scope: "parent",
          quick_actions: [{ label: "Xem Tiến bộ", href: "/reports" }],
          suggested_prompts: [],
          navigation_offer: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    global.fetch = fetchMock;

    const childUuid = "92000000-0000-4000-8000-000000000001";

    // Parent scope with non-empty selectedChildId -> sends selected_child_id (and strips camelCase selectedChildId)
    const parentLive = await sendAssistantMessage(
      {
        message: "Tuần này bé đọc mấy buổi?",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
        selectedChildId: `  ${childUuid}  `,
      },
      { online: true },
    );
    expect(parentLive.live_grounded).toBe(true);
    const parentBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(parentBody.selected_child_id).toBe(childUuid);
    expect(parentBody).not.toHaveProperty("selectedChildId");

    // Parent scope with blank/null selectedChildId -> omits selected_child_id
    await sendAssistantMessage(
      {
        message: "Hôm nay bé nên đọc gì?",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
        selectedChildId: "   ",
      },
      { online: true },
    );
    const blankBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(blankBody).not.toHaveProperty("selected_child_id");

    // Public scope (/login and /admin/login) -> NEVER forwards selected_child_id
    for (const publicPath of ["/login", "/admin/login"]) {
      await sendAssistantMessage(
        {
          message: "ViRead là gì?",
          current_path: publicPath,
          locale: "vi",
          bandwidth_profile: "high",
          history: [],
          selectedChildId: childUuid,
        },
        { online: true },
      );
      const latestBody = JSON.parse(
        String(
          fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1]?.body ??
            "{}",
        ),
      ) as Record<string, unknown>;
      expect(latestBody).not.toHaveProperty("selected_child_id");
    }

    // Admin scope (/admin/health) -> NEVER forwards selected_child_id
    await sendAssistantMessage(
      {
        message: "Thống kê vận hành",
        current_path: "/admin/health",
        locale: "vi",
        bandwidth_profile: "high",
        history: [],
        selectedChildId: childUuid,
      },
      { online: true },
    );
    const adminBody = JSON.parse(
      String(
        fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1]?.body ??
          "{}",
      ),
    ) as Record<string, unknown>;
    expect(adminBody).not.toHaveProperty("selected_child_id");

    // Defaults live_grounded to false when omitted by backend
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: "Hướng dẫn nhanh",
          source_tier: "tier_0_kb",
          provider_id: "viread_kb",
          model_id: null,
          bandwidth_applied: "low",
          latency_ms: 5,
          cached: false,
          role_scope: "parent",
          quick_actions: [],
          suggested_prompts: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const defaultGrounded = await sendAssistantMessage(
      {
        message: "Cách bắt đầu đọc",
        current_path: "/dashboard",
        locale: "vi",
        bandwidth_profile: "low",
        history: [],
      },
      { online: true },
    );
    expect(defaultGrounded.live_grounded).toBe(false);
  });

  it("expands Vietnamese shorthand in normalizeQuery, covers Wave 3 + PR #227 offline guides, and preserves domain/scope guards", () => {
    expect(normalizeQuery("doi mk")).toBe("doi mat khau");
    expect(normalizeQuery("tai sach offline qr")).toBe(
      "tai sach offline ma qr",
    );
    expect(normalizeQuery("ko mo dc hs gd ntn bn dt")).toBe(
      "khong mo duoc ho so gia dinh nhu the nao bao nhieu dien thoai",
    );

    const changePwdShorthand = resolveOfflineAssistantReply(
      "doi mk",
      "/dashboard",
      "vi",
      "high",
    );
    expect(changePwdShorthand.provider_id).toBe("viread_offline_guide");
    expect(changePwdShorthand.live_grounded).toBe(false);
    expect(changePwdShorthand.navigation_offer?.href).toBe("/settings");

    const offlinePackQr = resolveOfflineAssistantReply(
      "tai sach offline qr",
      "/dashboard",
      "vi",
      "low",
    );
    expect(offlinePackQr.provider_id).toBe("viread_offline_guide");
    expect(offlinePackQr.live_grounded).toBe(false);
    expect(offlinePackQr.reply).toContain("QR");
    expect(offlinePackQr.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/books",
        requires_child_selection: true,
        scenario_id: "offline_pack_and_printable_qr",
      }),
    );

    const lucBat = resolveOfflineAssistantReply(
      "luc bat",
      "/dashboard",
      "vi",
      "high",
    );
    expect(lucBat.provider_id).toBe("viread_offline_guide");
    expect(lucBat.reply).toContain("H^-1");
    expect(lucBat.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/reading-preparation",
        requires_child_selection: true,
        scenario_id: "camera_line_spotlight_and_luc_bat",
      }),
    );

    const weakWordLoop = resolveOfflineAssistantReply(
      "tu yeu",
      "/dashboard",
      "vi",
      "high",
    );
    expect(weakWordLoop.provider_id).toBe("viread_offline_guide");
    expect(weakWordLoop.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/entertainment",
        requires_child_selection: true,
        scenario_id: "entertainment_word_loop_autopilot",
      }),
    );

    const adminRadar = resolveOfflineAssistantReply(
      "radar mau ocr kho",
      "/admin/books",
      "vi",
      "high",
    );
    expect(adminRadar.provider_id).toBe("viread_offline_guide");
    expect(adminRadar.live_grounded).toBe(false);
    expect(adminRadar.navigation_offer).toEqual(
      expect.objectContaining({
        href: "/admin/metadata-quality",
        requires_child_selection: false,
        scenario_id: "admin_ocr_hard_sample_radar",
      }),
    );

    // Shorthand must NOT bypass scope or domain guards
    const shorthandOtherUser = resolveOfflineAssistantReply(
      "xem tk khac",
      "/dashboard",
      "vi",
      "high",
    );
    expect(shorthandOtherUser.provider_id).toBe("viread_scope_guard");
    expect(shorthandOtherUser.navigation_offer).toBeNull();

    const shorthandOffTopicWeather = resolveOfflineAssistantReply(
      "thoi tiet ha noi ntn",
      "/dashboard",
      "vi",
      "high",
    );
    expect(shorthandOffTopicWeather.provider_id).toBe("viread_domain_guard");
    expect(shorthandOffTopicWeather.navigation_offer).toBeNull();

    const shorthandOffTopicCrypto = resolveOfflineAssistantReply(
      "gia bitcoin bn",
      "/dashboard",
      "vi",
      "high",
    );
    expect(shorthandOffTopicCrypto.provider_id).toBe("viread_domain_guard");
    expect(shorthandOffTopicCrypto.navigation_offer).toBeNull();
  });
});
