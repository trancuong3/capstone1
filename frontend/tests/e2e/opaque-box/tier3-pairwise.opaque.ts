import { expect, test, type Page } from "@playwright/test";

import {
  OPAQUE_COVER_ASSET_ID,
  OPAQUE_SUBMISSION_ID,
  makeAdminBookDetail,
  makeAdminCatalogItem,
  makeAdminQualityBookDetail,
  makePrivateBookDetail,
  makePrivateBookListItem,
  makePrivateBookSubmission,
} from "./fixtures/cluster1-2-data";
import {
  OPAQUE_C4_KARAOKE_SONG_ID,
  OPAQUE_C4_KARAOKE_VERSION_ID,
  OPAQUE_EPISODE_ID,
  OPAQUE_PAGE_2_ID,
  OPAQUE_PRIVATE_BOOK_ID,
  OPAQUE_REV_2_ID,
  OPAQUE_VOICE_NORTH_ID,
  OPAQUE_VOICE_SOUTH_ID,
  makeReadingPage2Dto,
  makeReadingPageDto,
} from "./fixtures/cluster3-4-data";
import {
  OPAQUE_PARENT_ID,
  attachPageErrorCollector,
  createRoleContext,
  installApiMock,
} from "./fixtures/session";
import {
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_CRON_SECRET,
  OPAQUE_PAGE_ID,
  OPAQUE_REV_ID,
  OPAQUE_SESSION_ID,
  makeMinimalPngBuffer,
  makeMinimalWavBuffer,
  makeOpaqueUuid,
} from "./fixtures/test-data";
import {
  assertNoUnexpectedPageErrors,
  createTier34ApiHandler,
  createTier34State,
  fillHydrated,
  mockSupabasePasswordAuth,
  mockSupabaseStorageImages,
} from "./fixtures/tier3-4-data";

async function apiFetchInPage(
  page: Page,
  apiOrigin: string,
  token: string | null,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string>;
  json: unknown;
}> {
  return page.evaluate(
    async ({ baseUrl, bearer, routePath, reqInit }) => {
      const headers: Record<string, string> = {
        ...(reqInit.headers ?? {}),
      };
      if (bearer) {
        headers.Authorization = `Bearer ${bearer}`;
      }
      let body: BodyInit | undefined;
      if (reqInit.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(reqInit.body);
      }
      const response = await fetch(`${baseUrl}${routePath}`, {
        method: reqInit.method ?? "GET",
        headers,
        body,
      });
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        resHeaders[key.toLowerCase()] = value;
      });
      const ct = response.headers.get("content-type") ?? "";
      const json = ct.includes("application/json")
        ? await response.json().catch(() => null)
        : null;
      return { status: response.status, headers: resHeaders, json };
    },
    { baseUrl: apiOrigin, bearer: token, routePath: path, reqInit: init },
  );
}

test.describe("Tier 3: Cross-Feature Pairwise Interactions (26 Pairs)", () => {
  test("[T3-P01] F-01 x F-02: /auth/callback SSR guard, PKCE next sanitization & active profile fail-closed", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    const inactiveCtx = await createRoleContext(browser, "guest");
    try {
      await guest.context.addCookies([
        {
          name: "viread_auth_next",
          value: encodeURIComponent("/books"),
          url: guest.baseURL,
        },
      ]);

      // Un-headered /auth/callback error fails closed & clears viread_auth_next
      const deniedRes = await guest.context.request.get(
        "/auth/callback?error=access_denied",
        { maxRedirects: 0 },
      );
      expect(deniedRes.status()).toBe(307);
      const deniedLoc = new URL(
        deniedRes.headers().location ?? "",
        guest.baseURL,
      );
      expect(deniedLoc.pathname).toBe("/login");
      expect(deniedLoc.searchParams.get("oauth_error")).toBe("oauth_failed");

      // Unsafe next=//evil.com on /auth/callback never leaks to external host
      const evilRes = await guest.context.request.get(
        "/auth/callback?code=pkce_test_code&next=%2F%2Fevil.example.com",
        { maxRedirects: 0 },
      );
      expect(evilRes.status()).toBe(307);
      const evilLoc = new URL(evilRes.headers().location ?? "", guest.baseURL);
      expect(evilLoc.origin).toBe(new URL(guest.baseURL).origin);
      expect(evilLoc.pathname).toBe("/login");

      // Cross-role next=/admin/health sanitized to /dashboard on parent login
      const state = createTier34State();
      await installApiMock(guest.page, createTier34ApiHandler(state));
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
        active: 1,
      });

      await guest.page.goto("/login?next=%2Fadmin%2Fhealth", {
        waitUntil: "load",
      });
      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "parent@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "SecretPass123!",
      );
      await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(guest.page).toHaveURL(/\/dashboard$/);

      // Active=0 account fails closed in un-headered context
      await installApiMock(inactiveCtx.page, createTier34ApiHandler(state));
      await mockSupabasePasswordAuth(inactiveCtx.page, {
        userId: OPAQUE_PARENT_ID,
        email: "inactive@viread.local",
        role: "parent",
        active: 0,
      });
      await inactiveCtx.page.goto("/login", { waitUntil: "load" });
      await fillHydrated(
        inactiveCtx.page.getByLabel("Email của ba mẹ"),
        "inactive@viread.local",
      );
      await fillHydrated(
        inactiveCtx.page.getByLabel("Mật khẩu", { exact: true }),
        "SecretPass123!",
      );
      await inactiveCtx.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(
        inactiveCtx.page.locator(
          '[role="alert"]:not(#__next-route-announcer__)',
        ),
      ).toBeVisible();
    } finally {
      await Promise.all([guest.dispose(), inactiveCtx.dispose()]);
    }
  });

  test("[T3-P02] F-01 x F-04: Admin soft-deactivating parent blocks SSR /dashboard, /voice/status & /support/feedback", async ({
    browser,
  }) => {
    const sharedState = createTier34State({ actorRole: "admin" });
    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );

      // Parent initially active on /help-support
      await parent.page.goto("/help-support", {
        waitUntil: "domcontentloaded",
      });
      const activeVoice = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/voice/status",
      );
      expect(activeVoice.status).toBe(200);

      // Admin deactivates parent via /admin/parents UI
      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Vô hiệu hóa" })
        .first()
        .click();
      const dialog = admin.page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Vô hiệu hóa Parent" }).click();
      await expect
        .poll(() =>
          sharedState.cluster1.deactivatedParentIds.includes(OPAQUE_PARENT_ID),
        )
        .toBe(true);
      adminErrors.assertNoErrors();

      // Parent API calls fail closed 403
      const revokedVoice = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/voice/status",
      );
      expect(revokedVoice.status).toBe(403);

      await parent.page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await fillHydrated(parent.page.locator("#support-subject"), "Cần hỗ trợ");
      await fillHydrated(
        parent.page.locator("#support-message"),
        "Kiểm tra tài khoản đã vô hiệu hóa.",
      );
      await fillHydrated(
        parent.page.locator("#support-contact-email"),
        "parent@viread.local",
      );
      await parent.page.locator('form button[type="submit"]').click();
      await expect(
        parent.page.locator('[role="alert"]:not(#__next-route-announcer__)'),
      ).toBeVisible();

      // Clear Playwright fixture headers -> real SSR guard fails closed 307 /login
      await parent.context.setExtraHTTPHeaders({});
      const ssrRes = await parent.context.request.get("/dashboard", {
        maxRedirects: 0,
      });
      expect(ssrRes.status()).toBe(307);
      const ssrLoc = new URL(ssrRes.headers().location ?? "", parent.baseURL);
      expect(ssrLoc.pathname).toBe("/login");
      expect(ssrLoc.searchParams.get("next")).toBe("/dashboard");

      assertNoUnexpectedPageErrors(parentErrors, {
        allowFailedResourceStatuses: [403],
      });
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[T3-P03] F-01 x F-17: RTL viread_locale=ar persists from /login through /dashboard & X-ViRead-Locale header; invalid cookie falls back to vi", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest", { locale: "ar" });
    const badLocaleGuest = await createRoleContext(browser, "guest");
    try {
      const errors = attachPageErrorCollector(guest.page);
      const state = createTier34State();
      await installApiMock(guest.page, createTier34ApiHandler(state));
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
      });

      await guest.page.goto("/login", { waitUntil: "load" });
      await expect(guest.page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(guest.page.locator("html")).toHaveAttribute("dir", "rtl");

      await fillHydrated(
        guest.page.locator('input[type="email"]'),
        "parent@viread.local",
      );
      await fillHydrated(
        guest.page.locator('input[type="password"]'),
        "SecretPass123!",
      );
      await guest.page.locator('button[type="submit"]').click();

      await expect(guest.page).toHaveURL(/\/dashboard$/);
      await expect(guest.page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(guest.page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect
        .poll(() =>
          state.seenLocaleHeaders.some(
            (h) =>
              h.path === "/profiles/dashboard-summary" && h.locale === "ar",
          ),
        )
        .toBe(true);

      // Invalid path-traversal locale falls back cleanly to vi / ltr
      await badLocaleGuest.context.addCookies([
        {
          name: "viread_locale",
          value: "../../etc/passwd",
          url: badLocaleGuest.baseURL,
        },
      ]);
      await badLocaleGuest.page.goto("/login", {
        waitUntil: "domcontentloaded",
      });
      await expect(badLocaleGuest.page.locator("html")).toHaveAttribute(
        "lang",
        "vi",
      );
      await expect(badLocaleGuest.page.locator("html")).toHaveAttribute(
        "dir",
        "ltr",
      );

      errors.assertNoErrors();
    } finally {
      await Promise.all([guest.dispose(), badLocaleGuest.dispose()]);
    }
  });

  test("[T3-P04] F-02 x F-23: ViReadAndroid/1.0 OAuth loopback vs browser viread:// deep link", async ({
    browser,
  }) => {
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
    });
    const desktopGuest = await createRoleContext(browser, "guest");
    try {
      let capturedAuthorizeUrl: URL | null = null;
      await mockSupabasePasswordAuth(androidGuest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
        onAuthorize: (url) => {
          capturedAuthorizeUrl = url;
        },
      });

      await androidGuest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await androidGuest.page
        .getByRole("button", { name: "Tiếp tục với Google" })
        .click();

      await expect.poll(() => capturedAuthorizeUrl !== null).toBe(true);
      const redirectTo = new URL(
        capturedAuthorizeUrl!.searchParams.get("redirect_to") ?? "",
      );
      expect(redirectTo.origin).toBe("http://127.0.0.1:3000");
      expect(redirectTo.pathname).toBe("/auth/callback");
      expect(
        (redirectTo.searchParams.get("viread_nonce") ?? "").length,
      ).toBeGreaterThanOrEqual(16);

      // Desktop UA hitting ?app_shell=android redirects to viread://auth/callback
      const desktopRes = await desktopGuest.context.request.get(
        "/auth/callback?app_shell=android&code=pkce_123&next=%2Fbooks",
        { maxRedirects: 0 },
      );
      expect(desktopRes.status()).toBe(307);
      expect(desktopRes.headers().location).toBe(
        "viread://auth/callback?code=pkce_123&next=%2Fbooks",
      );

      const unsafeRes = await desktopGuest.context.request.get(
        "/auth/callback?app_shell=android&code=pkce_123&next=%2F%2Fevil.com",
        { maxRedirects: 0 },
      );
      expect(unsafeRes.status()).toBe(307);
      expect(unsafeRes.headers().location).toBe(
        "viread://auth/callback?code=pkce_123",
      );
    } finally {
      await Promise.all([androidGuest.dispose(), desktopGuest.dispose()]);
    }
  });

  test("[T3-P05] F-03 x F-07: Creating & deleting child invalidates cache and binds/blocks /reading-preparation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      await installApiMock(parent.page, createTier34ApiHandler(state));

      await parent.page.goto("/children/new", { waitUntil: "load" });
      await fillHydrated(
        parent.page.getByLabel("Tên gọi của bé"),
        "Bé Minh Châu",
      );
      await parent.page.getByLabel("Lớp của bé").selectOption("4");
      await parent.page.getByRole("button", { name: "Lưu hồ sơ" }).click();

      await expect(parent.page).toHaveURL(/\/children\/([^/?]+)\?created=1$/);
      const createdId = new URL(parent.page.url()).pathname.split("/").pop()!;

      // Select new child via sessionStorage & start reading from preparation
      await parent.page.evaluate(
        ({ ownerId, childId }) => {
          window.sessionStorage.setItem(
            `viread:selected-child:${ownerId}`,
            childId,
          );
        },
        { ownerId: OPAQUE_PARENT_ID, childId: createdId },
      );

      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("Bé Minh Châu")).toBeVisible();
      await parent.page.getByRole("button", { name: "Bắt đầu đọc" }).click();

      await expect(parent.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );
      expect(state.readingSessionsById[OPAQUE_SESSION_ID]?.child_id).toBe(
        createdId,
      );

      // Delete created child -> stale selection no longer starts session for deleted child
      await parent.page.goto(`/children/${createdId}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Xóa hồ sơ bé" }).click();
      await parent.page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Xóa hồ sơ" })
        .click();
      await expect(parent.page).toHaveURL(/\/children$/);

      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("Bé Minh Châu")).toHaveCount(0);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P06] F-03 x F-14: Updating child grade 2 -> 5 updates Entertainment recommendations & Memory/Shooter grade context", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      await installApiMock(parent.page, createTier34ApiHandler(state));

      await parent.page.goto(`/children/${OPAQUE_CHILD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByLabel("Lớp của bé").selectOption("5");
      await parent.page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await expect(parent.page.getByRole("status")).toBeVisible();

      await parent.page.goto("/entertainment", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByTestId("hub-active-child-badge"),
      ).toContainText("5");

      await parent.page.goto("/entertainment/sentence-shooter", {
        waitUntil: "domcontentloaded",
      });
      await expect
        .poll(() =>
          state.seenRequests.some(
            (r) =>
              r.pathname === "/games/sentence-shooter/books" &&
              r.method === "GET",
          ),
        )
        .toBe(true);

      await parent.page.goto("/entertainment/memory-game", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("Lớp 5 gợi ý")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P07] F-05 x F-07: Active catalog book starts reading session while RETIRED book blocks start", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      await installApiMock(parent.page, createTier34ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
      ).toBeVisible();

      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(parent.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );
      await expect(parent.page.locator("[data-word-id]").first()).toBeVisible();

      // Retire book -> reading preparation disables start & shows unavailable state
      state.cluster2.catalogBooks[0] = {
        ...state.cluster2.catalogBooks[0]!,
        lifecycle_status: "RETIRED",
      };
      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByRole("button", { name: "Bắt đầu đọc" }),
      ).toHaveCount(0);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [404],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P08] F-05 x F-18: Admin book approval exposes book in /books catalog; retiring removes it", async ({
    browser,
  }) => {
    const newBookId = makeOpaqueUuid(888, "82000000");
    const sharedState = createTier34State({ actorRole: "admin" });
    const adminBook = makeAdminBookDetail({
      id: newBookId,
      name: "cay-tre-tram-dot",
      title: "Cây Tre Trăm Đốt",
      author: "Dân gian",
    });
    sharedState.cluster2.adminCatalog.unshift(
      makeAdminCatalogItem({
        book: adminBook,
        page_count: 1,
        verified_count: 1,
        parent_catalog_eligible: false,
      }),
    );
    sharedState.cluster2.qualityBooks = [
      makeAdminQualityBookDetail({
        book_id: newBookId,
        book_title: "Cây Tre Trăm Đốt",
        assessment: {
          ...makeAdminQualityBookDetail().assessment,
          book_id: newBookId,
          status: "PENDING_ADMIN_REVIEW",
          rights_confirmed: false,
          admin_approved_at: null,
          admin_approved_by: null,
        },
      }),
    ];

    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );

      // Initially absent from parent catalog
      await parent.page.goto("/books", { waitUntil: "domcontentloaded" });
      await expect(parent.page.getByText("Cây Tre Trăm Đốt")).toHaveCount(0);

      // Admin records rights and approves
      await admin.page.goto("/admin/metadata-quality?tab=approval", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Xem kết quả" })
        .first()
        .click();
      const rightsPanel = admin.page.getByTestId("book-rights-panel");
      await rightsPanel.locator("select").selectOption("RIGHTS_REVIEWED");
      await rightsPanel.locator("input").nth(0).fill("PUBLIC_DOMAIN");
      await rightsPanel.locator("input").nth(1).fill("Truyện dân gian");
      await rightsPanel
        .getByRole("button", { name: "Lưu hồ sơ quyền sử dụng" })
        .click();
      await expect(rightsPanel.getByRole("status")).toBeVisible();

      await admin.page
        .locator("textarea")
        .last()
        .fill("Phê duyệt đưa vào tủ sách thiếu nhi.");
      await admin.page
        .getByRole("button", { name: "Phê duyệt toàn bộ sách" })
        .click();
      await expect
        .poll(() =>
          sharedState.cluster2.catalogBooks.some((b) => b.id === newBookId),
        )
        .toBe(true);

      // Parent /books now shows approved book
      await parent.page.reload({ waitUntil: "domcontentloaded" });
      await expect(parent.page.getByText("Cây Tre Trăm Đốt")).toBeVisible();

      // Admin retires book -> parent /books hides it & detail returns 404
      const retireRes = await apiFetchInPage(
        admin.page,
        parentApi.apiOrigin,
        admin.getAccessToken(),
        `/books/admin/catalog/${newBookId}`,
        { method: "PATCH", body: { lifecycle_status: "RETIRED" } },
      );
      expect(retireRes.status).toBe(200);

      await parent.page.reload({ waitUntil: "domcontentloaded" });
      await expect(parent.page.getByText("Cây Tre Trăm Đốt")).toHaveCount(0);

      adminErrors.assertNoErrors();
      parentErrors.assertNoErrors();
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[T3-P09] F-05 x F-19: Admin Cover Studio upload updates /books & /books/[bookId] cover via /studio/assets/{id}/media", async ({
    browser,
  }) => {
    const sharedState = createTier34State({ actorRole: "admin" });
    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      await mockSupabaseStorageImages(parent.page);

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Mở Cover Studio" }).click();
      await admin.page.getByTestId("cover-gallery-input").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await admin.page.getByRole("button", { name: "Cắt giữa 80%" }).click();
      await admin.page.getByRole("button", { name: "Lưu ảnh bìa" }).click();
      await expect(admin.page.getByText("Đã lưu ảnh bìa mới")).toBeVisible();

      expect(sharedState.cluster2.catalogBooks[0]?.cover_url).toContain(
        `/studio/assets/${OPAQUE_COVER_ASSET_ID}/media`,
      );

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect
        .poll(() =>
          sharedState.seenRequests.some(
            (r) =>
              r.method === "GET" &&
              r.pathname === `/studio/assets/${OPAQUE_COVER_ASSET_ID}/media`,
          ),
        )
        .toBe(true);

      const loadedImg = await parent.page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll("img"));
        return imgs.some((img) => img.complete && img.naturalWidth > 0);
      });
      expect(loadedImg).toBe(true);

      adminErrors.assertNoErrors();
      parentErrors.assertNoErrors();
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[T3-P10] F-06 x F-07: Private book becomes readable after add-page & fails closed when suspended", async ({
    browser,
  }) => {
    const sharedState = createTier34State();
    sharedState.cluster2.privateBooks = [
      makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_PRIVATE_BOOK_ID,
          title: "Truyện Gia Đình",
          committed_page_count: 0,
          readable_for_children: false,
        }),
        pages: [],
        submissions: [
          makePrivateBookSubmission({
            id: OPAQUE_SUBMISSION_ID,
            book_id: OPAQUE_PRIVATE_BOOK_ID,
            spelling_accepted: true,
            can_add_to_book: true,
            workflow_status: "PASSED_READY_TO_ADD",
          }),
        ],
      }),
    ];

    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const admin = await createRoleContext(browser, "admin");
    try {
      const parentErrors = attachPageErrorCollector(parent.page);
      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      const adminApi = await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/my-books/${OPAQUE_PRIVATE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: "Thêm trang vào sách" })
        .click();
      await expect(
        parent.page.getByText("Các trang đã thêm vào sách đọc (1)"),
      ).toBeVisible();

      // Start reading session on committed private book
      await parent.page.goto(
        `/reading-preparation?bookId=${OPAQUE_PRIVATE_BOOK_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await parent.page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(parent.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );

      // Admin suspends book -> subsequent reading session creation fails closed 403
      await admin.page.goto("/admin/books", { waitUntil: "domcontentloaded" });
      const suspendRes = await apiFetchInPage(
        admin.page,
        adminApi.apiOrigin,
        admin.getAccessToken(),
        `/books/admin/quality/user-books/${OPAQUE_PRIVATE_BOOK_ID}/suspend`,
        { method: "POST", body: { reason: "Kiểm tra an toàn" } },
      );
      expect(suspendRes.status).toBe(200);

      const blockedStart = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/reading/sessions",
        {
          method: "POST",
          body: {
            child_id: OPAQUE_CHILD_ID,
            book_id: OPAQUE_PRIVATE_BOOK_ID,
          },
        },
      );
      expect(blockedStart.status).toBe(403);

      parentErrors.assertNoErrors();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T3-P11] F-06 x F-10: Private-book TTS uses PRIVATE cache_scope & never leaks into CATALOG scope", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      state.readingSessionsById[OPAQUE_SESSION_ID] = {
        id: OPAQUE_SESSION_ID,
        child_id: OPAQUE_CHILD_ID,
        book_id: OPAQUE_PRIVATE_BOOK_ID,
        selected_page_id: OPAQUE_PAGE_ID,
        selected_page_revision_id: OPAQUE_REV_ID,
        state: "LISTENING",
        duration_ms: null,
      };
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .locator("[data-word-id]")
        .filter({ hasText: "Mèo" })
        .first()
        .click();

      await expect
        .poll(() =>
          state.seenRequests.some(
            (r) =>
              r.method === "POST" && r.pathname === "/voice/text-to-speech",
          ),
        )
        .toBe(true);
      const ttsReq = state.seenRequests.find(
        (r) => r.method === "POST" && r.pathname === "/voice/text-to-speech",
      );
      expect(ttsReq?.body).toMatchObject({
        cache_scope: "PRIVATE",
        book_id: OPAQUE_PRIVATE_BOOK_ID,
      });

      // Verify identical text on CATALOG scope gets MISS (not served from PRIVATE cache)
      const catalogRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Mèo",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(catalogRes.status).toBe(200);
      expect(catalogRes.headers["x-tts-scope"]).toBe("CATALOG");
      expect(catalogRes.headers["x-tts-cache"]).toBe("MISS");
      expect(catalogRes.headers["cache-control"]).toBe("no-store");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P12] F-06 x F-18: Flagged private submission request-admin-review -> Admin approval unlocks addPage", async ({
    browser,
  }) => {
    const sharedState = createTier34State();
    sharedState.cluster2.privateBooks = [
      makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_PRIVATE_BOOK_ID,
          title: "Sách Cần Duyệt",
        }),
        pages: [],
        submissions: [
          makePrivateBookSubmission({
            id: OPAQUE_SUBMISSION_ID,
            book_id: OPAQUE_PRIVATE_BOOK_ID,
            workflow_status: "NEEDS_ADMIN_REVIEW",
            spelling_accepted: true,
            can_add_to_book: false,
          }),
        ],
      }),
    ];
    sharedState.cluster2.userBookQueue = [];

    const parent = await createRoleContext(browser, "parent");
    const admin = await createRoleContext(browser, "admin");
    try {
      const parentErrors = attachPageErrorCollector(parent.page);
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      await mockSupabaseStorageImages(parent.page);
      await mockSupabaseStorageImages(admin.page);

      // Parent requests admin review
      await parent.page.goto(`/my-books/${OPAQUE_PRIVATE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const reqRes = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        `/books/my-books/${OPAQUE_PRIVATE_BOOK_ID}/submissions/${OPAQUE_SUBMISSION_ID}/request-admin-review`,
        { method: "POST", body: { note: "Nội dung hoàn toàn lành mạnh." } },
      );
      expect(reqRes.status).toBe(200);
      expect(sharedState.cluster2.userBookQueue.length).toBeGreaterThanOrEqual(
        1,
      );

      // Admin approves submission in Quality Hub User Books tab
      await admin.page.goto("/admin/metadata-quality?tab=user-books", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Mở để duyệt" })
        .first()
        .click();
      const drawer = admin.page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await drawer
        .locator("textarea")
        .first()
        .fill("Nội dung phù hợp trẻ em lớp 1-5.");
      await drawer.getByRole("button", { name: "Duyệt bản này" }).click();

      await expect
        .poll(
          () =>
            sharedState.cluster2.privateBooks[0]?.submissions[0]
              ?.workflow_status,
        )
        .toBe("APPROVED_READY_TO_ADD");

      // Parent reloads and commits page via addPage
      await parent.page.reload({ waitUntil: "domcontentloaded" });
      const addPageBtn = parent.page.getByRole("button", {
        name: "Thêm trang vào sách",
      });
      await expect(addPageBtn).toBeEnabled();
      await addPageBtn.click();
      await expect(
        parent.page.getByText("Các trang đã thêm vào sách đọc (1)"),
      ).toBeVisible();

      parentErrors.assertNoErrors();
      adminErrors.assertNoErrors();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T3-P13] F-06 x F-20: Flow 2 OCR contribution opt-in feeds Admin verification & /admin/viread-training dataset", async ({
    browser,
  }) => {
    const sharedState = createTier34State();
    sharedState.cluster2.privateBooks = [
      makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_PRIVATE_BOOK_ID,
          title: "Truyện Tự Sáng Tác",
          source_type: "SELF_AUTHORED",
          rights_eligible_for_training: true,
        }),
      }),
      makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_BOOK_ID,
          title: "Sách Bản Quyền",
          source_type: "COMMERCIAL_OR_COPYRIGHTED",
          rights_eligible_for_training: false,
        }),
      }),
    ];

    const parent = await createRoleContext(browser, "parent");
    const admin = await createRoleContext(browser, "admin");
    try {
      const parentErrors = attachPageErrorCollector(parent.page);
      const adminErrors = attachPageErrorCollector(admin.page);

      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      const adminApi = await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );

      // Non-SELF_AUTHORED book rejected for training opt-in
      await parent.page.goto(`/my-books/${OPAQUE_PRIVATE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const ineligibleRes = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        `/books/my-books/${OPAQUE_BOOK_ID}/ocr-contribution`,
        {
          method: "PUT",
          body: { enabled: true, rights_confirmed: true },
        },
      );
      expect(ineligibleRes.status).toBe(422);

      // Eligible SELF_AUTHORED opt-in via UI
      await parent.page
        .getByLabel(
          "Tôi xác nhận có quyền cho phép ViRead sử dụng ảnh cắt từng dòng chữ và nội dung tương ứng của cuốn sách này để cải thiện nhận diện chữ.",
        )
        .check();
      await parent.page
        .getByRole("button", { name: "Bật đóng góp mẫu nhận diện" })
        .click();
      await expect(
        parent.page.getByRole("button", { name: "Ngừng đóng góp" }),
      ).toBeVisible();
      expect(sharedState.flow2Candidates.length).toBe(1);

      // Admin verifies Flow 2 candidate & triggers Flow 2 on /admin/viread-training
      await admin.page.goto("/admin/metadata-quality?tab=user-books", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("tab", { name: "Xác minh mẫu đóng góp" })
        .click();
      await admin.page
        .getByRole("button", { name: "Xác nhận nhãn (Đạt · Đẩy đồng bộ)" })
        .click();
      await expect
        .poll(() => sharedState.flow2Candidates[0]?.status)
        .toBe("APPROVED");

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      const verifiedRes = await apiFetchInPage(
        admin.page,
        adminApi.apiOrigin,
        admin.getAccessToken(),
        "/books/admin/viread-training/datasets/flow2-admin-verified",
      );
      expect(verifiedRes.status).toBe(200);
      expect((verifiedRes.json as { total: number }).total).toBe(1);

      const triggerRes = await apiFetchInPage(
        admin.page,
        adminApi.apiOrigin,
        admin.getAccessToken(),
        "/books/admin/viread-training/flow2/trigger",
        { method: "POST" },
      );
      expect(triggerRes.status).toBe(200);

      assertNoUnexpectedPageErrors(parentErrors, {
        allowFailedResourceStatuses: [422],
      });
      adminErrors.assertNoErrors();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T3-P14] F-07 x F-08: Reading absence triggers presence pause + alert, and opt-out cancels alert", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      state.cluster3.presenceEmailEnabled = true;
      state.cluster3.sessionSummary = { state: "LISTENING" };
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.addInitScript(() => {
        let detectCount = 0;
        let virtualOffsetMs = 0;
        const origPerfNow = performance.now.bind(performance);
        performance.now = () => origPerfNow() + virtualOffsetMs;
        const origSetInterval = window.setInterval.bind(window);
        window.setInterval = ((
          handler: TimerHandler,
          timeout?: number,
          ...args: unknown[]
        ) => {
          if (timeout === 1000 && typeof handler === "function") {
            return origSetInterval(() => {
              virtualOffsetMs += 1050;
              handler(...args);
            }, 25);
          }
          return origSetInterval(handler, timeout, ...args);
        }) as typeof window.setInterval;
        class MockFaceDetector {
          async detect(): Promise<Array<Record<string, unknown>>> {
            detectCount += 1;
            return detectCount <= 4 ? [{}] : [];
          }
        }
        (window as unknown as { FaceDetector: unknown }).FaceDetector =
          MockFaceDetector;
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (
          constraints?: MediaStreamConstraints,
        ) => {
          if (constraints?.video && !constraints.audio) {
            const canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = 120;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.fillStyle = "#202020";
              ctx.fillRect(0, 0, 160, 120);
            }
            return canvas.captureStream(5);
          }
          return origGetUserMedia(constraints);
        };
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText(
          "ViRead đã tạm dừng vì một lúc không thấy người đọc trong khung hình. Bé quay lại thì bấm Tiếp tục nhé.",
        ),
      ).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(() =>
          state.seenRequests.some(
            (r) =>
              r.method === "POST" && r.pathname === "/reading-presence/alerts",
          ),
        )
        .toBe(true);

      const alertIds = Object.keys(state.cluster3.presenceAlertsById ?? {});
      expect(alertIds.length).toBeGreaterThanOrEqual(1);
      const cancelRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading-presence/alerts/${alertIds[0]}/cancel`,
        { method: "POST", body: { reason: "OPT_OUT" } },
      );
      expect(cancelRes.status).toBe(200);
      expect(
        state.cluster3.presenceAlertsById?.[alertIds[0]!]?.cancel_reason,
      ).toBe("OPT_OUT");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P15] F-07 x F-09: Book scanner page match routes to matched pageId in reading-preparation & /reading/[sessionId]", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      state.cluster3.page1 = makeReadingPageDto();
      state.cluster3.page2 = makeReadingPage2Dto();
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });
      // Simulate page 2 match from scanner API & verify navigation contract
      const matchRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/reading/match-page",
        { method: "POST", body: {} },
      );
      expect(matchRes.status).toBe(200);

      // Verify matched pageId=OPAQUE_PAGE_2_ID binds directly into reading preparation & session
      await parent.page.goto(
        `/reading-preparation?bookId=${OPAQUE_BOOK_ID}&pageId=${OPAQUE_PAGE_2_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await parent.page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(parent.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );

      const createReq = state.seenRequests.find(
        (r) => r.method === "POST" && r.pathname === "/reading/sessions",
      );
      expect(createReq?.body).toMatchObject({
        selected_page_id: OPAQUE_PAGE_2_ID,
        selected_page_revision_id: OPAQUE_REV_2_ID,
      });
      await expect(parent.page.getByText("Thỏ").first()).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P16] F-07 x F-10: Reading session locks voice, plays TTS (MISS->HIT), Phonics & Timed TTS, and degrades safely on STT 503", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const token = parent.getAccessToken();

      const lockRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/session-lock",
        {
          method: "PUT",
          body: {
            session_id: OPAQUE_SESSION_ID,
            voice_id: OPAQUE_VOICE_SOUTH_ID,
          },
        },
      );
      expect(lockRes.status).toBe(200);
      expect((lockRes.json as { region: string }).region).toBe("south");

      const tts1 = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Chú mèo",
            voice_id: OPAQUE_VOICE_SOUTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(tts1.headers["x-tts-cache"]).toBe("MISS");

      const tts2 = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Chú mèo",
            voice_id: OPAQUE_VOICE_SOUTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(tts2.headers["x-tts-cache"]).toBe("HIT");

      const timedRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech/timed",
        {
          method: "POST",
          body: { words: ["Chú", "mèo"], voice_id: OPAQUE_VOICE_SOUTH_ID },
        },
      );
      expect(timedRes.status).toBe(200);

      const phonicsRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech/phonics",
        {
          method: "POST",
          body: {
            steps: [{ id: "rhyme_build", text: "mèo" }],
            voice_id: OPAQUE_VOICE_SOUTH_ID,
          },
        },
      );
      expect(phonicsRes.status).toBe(200);

      // STT 503 degradation does not break active session
      state.faults["POST /voice/speech-to-text"] = {
        status: 503,
        body: { detail: "VOICE_UNAVAILABLE" },
      };
      const stt503 = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/speech-to-text",
        { method: "POST", body: {} },
      );
      expect(stt503.status).toBe(503);
      await expect(parent.page.locator("[data-word-id]").first()).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [503],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P17] F-07 x F-11: Finishing reading generates tutor questions (no ExpectedAnswer) & grades TRY_AGAIN -> CORRECT -> SessionComplete", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      let leakedExpectedAnswer = false;
      const baseHandler = createTier34ApiHandler(state);
      await installApiMock(parent.page, async (ctx) => {
        const res =
          typeof baseHandler === "function"
            ? await baseHandler(ctx)
            : undefined;
        if (
          ctx.method === "GET" &&
          ctx.pathname.endsWith("/questions/next") &&
          res?.body
        ) {
          const serialized = JSON.stringify(res.body);
          if (
            serialized.includes("expected_answer") ||
            serialized.includes("ExpectedAnswer")
          ) {
            leakedExpectedAnswer = true;
          }
        }
        return res;
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: "Kết thúc buổi đọc" })
        .click();
      await parent.page.getByRole("button", { name: "Lưu và dừng" }).click();

      await expect(
        parent.page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
      ).toBeVisible();
      expect(leakedExpectedAnswer).toBe(false);

      // Submit wrong answer first -> TRY_AGAIN hint
      await parent.page
        .getByRole("button", { name: "Một chiếc lá vàng" })
        .click();
      await expect(
        parent.page.getByText(/Gần đúng rồi|Bé đọc lại đoạn đầu/),
      ).toBeVisible();

      // Submit right answer -> CORRECT, advance & finish
      await parent.page
        .getByRole("button", { name: "Một giỏ dâu rừng đỏ mọng" })
        .click();
      await parent.page.getByRole("button", { name: "Câu tiếp theo" }).click();

      await expect(
        parent.page.getByText("Từ nào chỉ ánh sáng dịu nhẹ?"),
      ).toBeVisible();
      await parent.page.getByRole("button", { name: "lấp lánh" }).click();
      await parent.page.getByRole("button", { name: "Hoàn thành" }).click();

      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/,
        }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P18] F-07 x F-12: Reading WORD_RETRY event & finish populate /sessions/[id] & /reports/difficult-words with nullable fluency", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const eventRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/reading/events",
        {
          method: "POST",
          body: {
            SessionId: OPAQUE_SESSION_ID,
            PageId: OPAQUE_PAGE_ID,
            PageRevisionId: OPAQUE_REV_ID,
            Type: "WORD_RETRY",
            Status: "CONFIRMED",
            StartMs: 1200,
            Metadata: { word: "khúc khích" },
          },
        },
      );
      expect(eventRes.status).toBe(201);

      const finishRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading/sessions/${OPAQUE_SESSION_ID}/finish`,
        { method: "POST", body: { duration_ms: 900_000 } },
      );
      expect(finishRes.status).toBe(200);

      await parent.page.goto(`/sessions/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByTestId("session-primary-reading-report"),
      ).toBeVisible();

      await parent.page.goto("/reports/difficult-words", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("khúc khích").first()).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P19] F-07 x F-13: Completing reading session advances goal/plan progress & invalidates /dashboard summary cache", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      state.readingGoals[0] = {
        ...state.readingGoals[0]!,
        target_value: 30,
        current_value: 0,
        progress_percent: 0,
      };
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.goto("/reading-management", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("0 / 30")).toBeVisible();

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const finishRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading/sessions/${OPAQUE_SESSION_ID}/finish`,
        { method: "POST", body: { duration_ms: 900_000 } },
      );
      expect(finishRes.status).toBe(200);

      await parent.page.goto("/reading-management", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("15 / 30")).toBeVisible();

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await expect
        .poll(() =>
          state.seenRequests.some(
            (r) =>
              r.method === "GET" &&
              r.pathname === "/profiles/dashboard-summary",
          ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P20] F-07 x F-17: Arabic RTL UI shell keeps .viread-learning-content locked to dir=ltr lang=vi", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      locale: "ar",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      await installApiMock(parent.page, createTier34ApiHandler(state));

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(parent.page.locator("html")).toHaveAttribute("dir", "rtl");

      const learningBox = parent.page
        .locator(".viread-learning-content")
        .first();
      await expect(learningBox).toBeVisible();
      await expect(learningBox).toHaveAttribute("dir", "ltr");
      await expect(learningBox).toHaveAttribute("lang", "vi");

      await expect
        .poll(() =>
          state.seenLocaleHeaders.some(
            (h) => h.path.startsWith("/reading/sessions/") && h.locale === "ar",
          ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P21] F-08 x F-13: Confirmed presence alert dispatches via /api/cron/parent-emails?scope=presence with X-Cron-Secret", async ({
    browser,
    request,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const state = createTier34State();
    state.cluster3.presenceEmailEnabled = true;
    const apiOrigin = (
      process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() ||
      process.env.NEXT_PUBLIC_API_URL?.trim() ||
      `http://127.0.0.1:${process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180"}`
    ).replace(/\/+$/, "");

    try {
      await request.post(`${apiOrigin}/__contract/reset`);
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );
      await parent.page.goto("/settings", { waitUntil: "domcontentloaded" });

      const armRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/reading-presence/alerts",
        {
          method: "POST",
          body: {
            session_id: OPAQUE_SESSION_ID,
            episode_id: OPAQUE_EPISODE_ID,
          },
        },
      );
      expect(armRes.status).toBe(201);
      const alertId = (armRes.json as { id: string }).id;

      const confirmRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading-presence/alerts/${alertId}/confirm`,
        { method: "POST" },
      );
      expect(confirmRes.status).toBe(200);

      // Invalid secret rejected 401
      const unauthCron = await request.post(
        "/api/cron/parent-emails?scope=presence",
        { headers: { Authorization: "Bearer invalid_secret" } },
      );
      expect(unauthCron.status()).toBe(401);

      // Valid Bearer secret hits contract server with X-Cron-Secret
      const cronRes = await request.post(
        "/api/cron/parent-emails?scope=presence",
        { headers: { Authorization: `Bearer ${OPAQUE_CRON_SECRET}` } },
      );
      expect(cronRes.status()).toBe(200);
      const cronJson = (await cronRes.json()) as {
        ok: boolean;
        summary: { scope: string; delivery_configured: boolean };
      };
      expect(cronJson.ok).toBe(true);
      expect(cronJson.summary.scope).toBe("presence");

      const statsRes = await request.get(`${apiOrigin}/__contract/stats`);
      const statsJson = (await statsRes.json()) as {
        cronAttempts: number;
        requests: Array<{
          path: string;
          query: string;
          headers: Record<string, string>;
        }>;
      };
      expect(statsJson.cronAttempts).toBeGreaterThanOrEqual(1);
      const dispatchReq = statsJson.requests.find(
        (r) => r.path === "/parent-notifications/cron/dispatch",
      );
      expect(dispatchReq?.headers["x-cron-secret"]).toBe(OPAQUE_CRON_SECRET);

      // Cancel with OPT_OUT -> stateful handler reports presence_sent: 0
      await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading-presence/alerts/${alertId}/cancel`,
        { method: "POST", body: { reason: "OPT_OUT" } },
      );
      const dispatchAfterOptOut = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/parent-notifications/cron/dispatch?scope=presence",
        { method: "POST" },
      );
      expect(
        (dispatchAfterOptOut.json as { presence_sent: number }).presence_sent,
      ).toBe(0);
    } finally {
      await request
        .post(`${apiOrigin}/__contract/reset`)
        .catch(() => undefined);
      await parent.dispose();
    }
  });

  test("[T3-P22] F-10 x F-12: Difficult word practice shares TTS, evaluates WAV audio, completes & enforces 409 on replay", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.goto("/reports/difficult-words", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("lấp lánh").first()).toBeVisible();

      const ttsRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/voice/text-to-speech",
        {
          method: "POST",
          body: { text: "lấp lánh", voice_id: OPAQUE_VOICE_NORTH_ID },
        },
      );
      expect(ttsRes.status).toBe(200);

      const startRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/start`,
        {
          method: "POST",
          body: {
            request_id: makeOpaqueUuid(1, "f1200010"),
            normalized_word: "lấp lánh",
            display_text: "lấp lánh",
          },
        },
      );
      expect(startRes.status).toBe(200);
      const attemptId = (startRes.json as { attempt_id: string }).attempt_id;

      // Submit multipart WAV via browser FormData
      const wavB64 = makeMinimalWavBuffer(300).toString("base64");
      const evalStatus = await parent.page.evaluate(
        async ({ baseUrl, bearer, childId, aid, audioB64 }) => {
          const binary = Uint8Array.from(atob(audioB64), (c) =>
            c.charCodeAt(0),
          );
          const form = new FormData();
          form.append("completion_request_id", "req-1");
          form.append(
            "file",
            new Blob([binary], { type: "audio/wav" }),
            "word.wav",
          );
          form.append("audio_duration_ms", "300");
          const res = await fetch(
            `${baseUrl}/system/difficult-words/${childId}/practice/${aid}/evaluate-audio`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${bearer}` },
              body: form,
            },
          );
          return res.status;
        },
        {
          baseUrl: api.apiOrigin,
          bearer: parent.getAccessToken() ?? "",
          childId: OPAQUE_CHILD_ID,
          aid: attemptId,
          audioB64: wavB64,
        },
      );
      expect(evalStatus).toBe(200);

      const complete1 = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${attemptId}/complete`,
        { method: "POST", body: { completion_request_id: "req-2" } },
      );
      expect(complete1.status).toBe(200);
      expect(
        (
          complete1.json as {
            word_progress: { practice_status: string };
          }
        ).word_progress.practice_status,
      ).toBe("COMPLETED");

      const complete2 = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${attemptId}/complete`,
        { method: "POST", body: { completion_request_id: "req-3" } },
      );
      expect(complete2.status).toBe(409);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [409],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P23] F-12 x F-14: Difficult words seed Entertainment & Sentence Shooter focus_words and update parent analytics", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      await installApiMock(parent.page, createTier34ApiHandler(state));

      await parent.page.goto("/entertainment", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("lấp lánh").first()).toBeVisible();

      await parent.page.goto("/entertainment/sentence-shooter", {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: /Bắt đầu|Chơi ngay/ })
        .first()
        .click();

      await expect(
        parent.page.getByTestId("difficult-word-badge").first(),
      ).toBeVisible();
      await parent.page.getByRole("button", { name: "Ánh nắng" }).click();
      await parent.page.getByRole("button", { name: "lấp lánh" }).click();

      await expect(
        parent.page.getByTestId("practiced-difficult-words"),
      ).toBeVisible();

      await parent.page.goto("/reports", { waitUntil: "domcontentloaded" });
      await expect(parent.page.getByText("lấp lánh").first()).toBeVisible();
      const practiced = state.parentAnalytics
        .practiced_difficult_words as Array<{
        normalized_word: string;
        practice_count: number;
      }>;
      expect(practiced[0]?.practice_count).toBeGreaterThanOrEqual(3);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P24] F-14 x F-15: Saving Karaoke practice invalidates /learning caches and surfaces KARAOKE evidence in /reports", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      await parent.page.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByTestId("karaoke-stage")).toBeVisible();

      const saveRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/karaoke/practice-sessions",
        {
          method: "POST",
          body: {
            child_id: OPAQUE_CHILD_ID,
            song_id: OPAQUE_C4_KARAOKE_SONG_ID,
            song_version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
            practice_mode: "FULL_SONG",
            scoring_mode: "FULL_MUSICAL",
            playback_rate: 0.85,
            headphone_mode: false,
            overall_score: 88,
            rhythm_score: 86,
            pitch_score: 90,
            lyrics_score: 88,
            fluency_score: 87,
            stars: 3,
            segment_start_ms: null,
            segment_end_ms: null,
            report_payload: {},
          },
        },
      );
      expect(saveRes.status).toBe(201);

      await parent.page.goto("/reports", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Karaoke thiếu nhi").first(),
      ).toBeVisible();
      await expect(
        parent.page.getByText("Chú ý giữ nhịp ở câu thứ hai nhé."),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T3-P25] F-16 x F-01/F-04: Assistant role_scope isolation (public vs parent vs admin), 429 Retry-After & offline fallback", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    const parent = await createRoleContext(browser, "parent");
    const admin = await createRoleContext(browser, "admin");
    try {
      const guestState = createTier34State({ actorRole: "guest" });
      const parentState = createTier34State({ actorRole: "parent" });
      const adminState = createTier34State({ actorRole: "admin" });

      await installApiMock(
        guest.page,
        createTier34ApiHandler(guestState, { roleOverride: "guest" }),
      );
      await installApiMock(
        parent.page,
        createTier34ApiHandler(parentState, { roleOverride: "parent" }),
      );
      await installApiMock(
        admin.page,
        createTier34ApiHandler(adminState, { roleOverride: "admin" }),
      );

      // 1. Guest -> no Authorization header, role_scope = public
      await guest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await guest.page.getByTestId("viread-assistant-launcher").click();
      await expect(
        guest.page.getByTestId("viread-assistant-panel"),
      ).toBeVisible();
      await guest.page.locator('input[maxlength="800"]').fill("Hỏi công khai");
      await guest.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        guest.page.getByText("Gợi ý (public): Hỏi công khai"),
      ).toBeVisible();
      expect(guestState.seenAssistantRequests[0]?.hasAuth).toBe(false);

      // 2. Parent -> Bearer sent, role_scope = parent
      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await parent.page.getByTestId("viread-assistant-launcher").click();
      await parent.page.locator('input[maxlength="800"]').fill("Hỏi phụ huynh");
      await parent.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        parent.page.getByText("Gợi ý (parent): Hỏi phụ huynh"),
      ).toBeVisible();
      expect(parentState.seenAssistantRequests[0]?.hasAuth).toBe(true);

      // 3. Admin -> role_scope = admin, plus 429 rate-limit + 502 offline fallback
      await admin.page.goto("/admin/health", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByTestId("viread-assistant-launcher").click();
      await admin.page.locator('input[maxlength="800"]').fill("Hỏi quản trị");
      await admin.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        admin.page.getByText("Gợi ý (admin): Hỏi quản trị"),
      ).toBeVisible();

      adminState.assistantForceStatus = 429;
      await admin.page.locator('input[maxlength="800"]').fill("Thử vượt hạn");
      await admin.page.locator('input[maxlength="800"]').press("Enter");
      await expect(admin.page.getByText(/giới hạn|chờ|thử lại/i)).toBeVisible();

      adminState.assistantForceStatus = 502;
      await admin.page
        .locator('input[maxlength="800"]')
        .fill("Chế độ ngoại tuyến");
      await admin.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        admin.page.getByTestId("viread-assistant-source-meta").last(),
      ).toContainText("Hướng dẫn ngoại tuyến");
    } finally {
      await Promise.all([guest.dispose(), parent.dispose(), admin.dispose()]);
    }
  });

  test("[T3-P26] F-18 x F-19: Smart OCR block extraction applies canonical text directly into Admin OCR revision draft & verifies", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createTier34State({ actorRole: "admin" });
      await installApiMock(
        admin.page,
        createTier34ApiHandler(state, { roleOverride: "admin" }),
      );
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );

      await admin.page
        .getByRole("tab", { name: /Khối thông minh V2/i })
        .click();
      await admin.page
        .getByRole("button", { name: "Mở phân loại khối chữ thông minh" })
        .click();
      await expect(
        admin.page.getByText("Rà soát nội dung trích xuất thông minh"),
      ).toBeVisible();

      await admin.page.getByRole("button", { name: "Loại bỏ" }).first().click();
      await admin.page.getByTestId("apply-ocr-to-draft-btn").click();

      await expect
        .poll(() =>
          state.seenRequests.some(
            (r) =>
              r.method === "POST" &&
              r.pathname ===
                `/studio/pages/${OPAQUE_PAGE_ID}/ocr-extraction/apply-to-draft`,
          ),
        )
        .toBe(true);

      await admin.page
        .getByRole("button", { name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG" })
        .click();
      await expect
        .poll(
          () =>
            state.cluster2.adminRevisionsByPage[OPAQUE_PAGE_ID]
              ?.verification_status,
        )
        .toBe("VERIFIED");

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });
});
