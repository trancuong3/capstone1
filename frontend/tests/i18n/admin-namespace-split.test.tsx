import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminLoaderOverride, cookiesMock } = vi.hoisted(() => ({
  adminLoaderOverride: {
    impl: null as
      | null
      | ((
          rawLocale: unknown,
          actualLoader: (
            rawLocale: unknown,
          ) => Promise<import("@/lib/i18n/types").MessageTree>,
        ) => Promise<import("@/lib/i18n/types").MessageTree>),
  },
  cookiesMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("@/messages/admin-loader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/messages/admin-loader")>();
  return {
    ...actual,
    loadAdminLocaleMessages: (rawLocale: unknown) =>
      adminLoaderOverride.impl
        ? adminLoaderOverride.impl(rawLocale, actual.loadAdminLocaleMessages)
        : actual.loadAdminLocaleMessages(rawLocale),
  };
});

import { AdminI18nProvider } from "@/components/i18n/admin-i18n-provider";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME } from "@/lib/i18n/locales";
import { translateRuntime } from "@/lib/i18n/runtime";
import { getServerAdminI18n, getServerI18n } from "@/lib/i18n/server";
import { resetAdminLoaderStateForTests } from "@/messages/admin-loader";
import {
  clearAllRuntimeNamespacesForTests,
  registerPersistentTestNamespace,
  resetLocaleLoaderStateForTests,
} from "@/messages/loader";
import { viMessages } from "@/messages/vi";
import viAdminMessages from "@/messages/vi/admin.json";

function AdminProbe() {
  const { locale, setLocale } = useI18n();
  const tAdmin = useTranslations("admin");
  const tCommon = useTranslations("common");

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="admin-title">{tAdmin("routes.booksTitle")}</span>
      <span data-testid="common-save">{tCommon("actions.save")}</span>
      <span data-testid="runtime-title">
        {translateRuntime("admin.routes.booksTitle")}
      </span>
      <button onClick={() => void setLocale("en")} type="button">
        EN
      </button>
      <button onClick={() => void setLocale("ar")} type="button">
        AR
      </button>
      <button onClick={() => void setLocale("he")} type="button">
        HE
      </button>
    </div>
  );
}

describe("M4-A admin i18n namespace split", () => {
  beforeEach(() => {
    adminLoaderOverride.impl = null;
    cookiesMock.mockReset();
    document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
    window.localStorage.clear();
    document.documentElement.lang = "vi";
    document.documentElement.dir = "ltr";
    resetLocaleLoaderStateForTests();
    resetAdminLoaderStateForTests();
  });

  afterEach(() => {
    adminLoaderOverride.impl = null;
    registerPersistentTestNamespace(DEFAULT_LOCALE, "admin", viAdminMessages);
  });

  it("excludes admin from getServerI18n while keeping common.taskCenter, and includes admin in getServerAdminI18n", async () => {
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === LOCALE_COOKIE_NAME ? { value: "en" } : undefined,
    });

    const rootSnapshot = await getServerI18n();
    expect(rootSnapshot.locale).toBe("en");
    expect(rootSnapshot.messages.admin).toBeUndefined();
    expect(
      (rootSnapshot.messages.common as Record<string, unknown>).taskCenter,
    ).toBeDefined();

    const adminSnapshot = await getServerAdminI18n();
    expect(adminSnapshot.locale).toBe("en");
    expect(adminSnapshot.messages.admin).toBeDefined();
    expect(adminSnapshot.adminMessages.routes).toBeDefined();
    expect(adminSnapshot.fallbackMessages.admin).toBeDefined();
  });

  it("provides admin translations and switches locales without raw keys via AdminI18nProvider", async () => {
    const adminSnapshot = await getServerAdminI18n();

    render(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <AdminI18nProvider
          initialAdminMessages={adminSnapshot.adminMessages}
          initialLocale={adminSnapshot.locale}
          viAdminMessages={adminSnapshot.viAdminMessages}
        >
          <AdminProbe />
        </AdminI18nProvider>
      </I18nProvider>,
    );

    expect(screen.getByTestId("locale")).toHaveTextContent("vi");
    expect(screen.getByTestId("admin-title")).not.toHaveTextContent(
      "admin.routes.booksTitle",
    );
    expect(screen.getByTestId("runtime-title")).toHaveTextContent(
      screen.getByTestId("admin-title").textContent ?? "",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "EN" }));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("locale")).toHaveTextContent("en");
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("admin-title")).not.toHaveTextContent(
      "admin.routes.booksTitle",
    );
    expect(screen.getByTestId("common-save")).toHaveTextContent("Save");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AR" }));
    });
    await waitFor(
      () => {
        expect(screen.getByTestId("locale")).toHaveTextContent("ar");
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("admin-title")).not.toHaveTextContent(
      "admin.routes.booksTitle",
    );
  });

  it("renders GlobalTaskCenter using root-only viMessages without admin namespace loaded", async () => {
    clearAllRuntimeNamespacesForTests();
    expect(viMessages.admin).toBeUndefined();

    const service = {
      listTasks: vi.fn().mockResolvedValue({
        actor_id: "parent-1",
        actor_role: "parent",
        active_count: 0,
        waiting_review_count: 0,
        failed_count: 1,
        completed_count: 0,
        worker_online: true,
        recommended_poll_ms: null,
        tasks: [
          {
            id: "task-1",
            source: "smart_studio_job",
            job_type: "OCR_EXTRACT",
            title_vi: "OCR test",
            book_id: "book-1",
            book_page_id: null,
            book_title: "Sách mẫu",
            page_number: 1,
            source_revision_id: null,
            actor_role: "parent",
            status: "FAILED",
            status_label_vi: "Lỗi",
            stage: "OCR",
            stage_label_vi: "OCR",
            priority: 50,
            attempt_count: 1,
            max_attempts: 3,
            progress_completed: null,
            progress_total: null,
            progress_unit: null,
            progress_pct: null,
            is_indeterminate: true,
            can_retry: true,
            can_cancel: false,
            result_href: null,
            result_ref: {},
            checkpoints: {},
            error_code: null,
            error_message_vi: null,
            created_at: "2026-11-25T14:00:00.000Z",
            updated_at: "2026-11-25T14:00:00.000Z",
            started_at: "2026-11-25T14:00:00.000Z",
            completed_at: null,
          },
        ],
      }),
      createTask: vi.fn(),
      retryTask: vi.fn(),
      cancelTask: vi.fn(),
      getCapabilities: vi.fn(),
    };

    render(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <AiTaskCenterProvider
          actorId="parent-1"
          actorRole="parent"
          service={service}
        >
          <GlobalTaskCenter variant="header-pill" />
        </AiTaskCenterProvider>
      </I18nProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));
    fireEvent.click(trigger);

    const panel = await screen.findByTestId("global-task-center-panel");
    expect(panel).toHaveTextContent("Trung tâm tác vụ AI");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });

  it("ignores stale slow setLocale resolution during rapid out-of-order switching (en 80ms -> he 5ms)", async () => {
    const adminSnapshot = await getServerAdminI18n();
    adminLoaderOverride.impl = async (rawLocale, actualLoader) => {
      const delayMs = rawLocale === "en" ? 80 : rawLocale === "he" ? 5 : 0;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return actualLoader(rawLocale);
    };

    render(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <AdminI18nProvider
          initialAdminMessages={adminSnapshot.adminMessages}
          initialLocale={adminSnapshot.locale}
          viAdminMessages={adminSnapshot.viAdminMessages}
        >
          <AdminProbe />
        </AdminI18nProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    fireEvent.click(screen.getByRole("button", { name: "HE" }));

    await waitFor(
      () => {
        expect(screen.getByTestId("locale")).toHaveTextContent("he");
      },
      { timeout: 4000 },
    );

    // Wait past the slower 80ms "en" resolution to prove it does not revert "he"
    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(screen.getByTestId("locale")).toHaveTextContent("he");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("he");
    expect(screen.getByTestId("admin-title")).toHaveTextContent(
      "ספריית ספרים ניהולית",
    );
  });
});
