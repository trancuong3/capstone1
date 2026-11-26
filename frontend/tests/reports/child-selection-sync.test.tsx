import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { clearApiReadCache } from "@/lib/api/read-cache";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import {
  childFixture,
  difficultWordFixture,
  progressReportFixture,
} from "@/test/fixtures/report-data-fixture";
import type { ChildProfileDTO } from "@/types/child";

const CHILD_A: ChildProfileDTO = {
  ...childFixture,
  id: "11111111-1111-4111-8111-111111111111",
  parent_id: authSessionFixture.user.id,
  alias: "Bé An",
  grade: 2,
};

const CHILD_B: ChildProfileDTO = {
  ...childFixture,
  id: "22222222-2222-4222-8222-222222222222",
  parent_id: authSessionFixture.user.id,
  alias: "Bé Bình",
  grade: 3,
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/reports",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
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

function TopBarSwitcherHarness() {
  const { selectedChildId, selectChild, clearSelectedChild } = useAppStore();
  return (
    <div>
      <output aria-label="Store selected child">
        {selectedChildId ?? "none"}
      </output>
      <button onClick={() => selectChild(CHILD_B.id)} type="button">
        Switch to Child B
      </button>
      <button onClick={clearSelectedChild} type="button">
        Clear child selection
      </button>
    </div>
  );
}

describe("Child selection store sync does not revert mid-navigation external switches", () => {
  const storageKey = `viread:selected-child:${authSessionFixture.user.id}`;

  beforeEach(() => {
    window.localStorage.clear();
    clearApiReadCache();
    installApiFetchFixture();
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === "/profiles/children") {
        return Response.json([CHILD_A, CHILD_B]);
      }
      if (path === `/profiles/children/${CHILD_A.id}`) {
        return Response.json(CHILD_A);
      }
      if (path === `/profiles/children/${CHILD_B.id}`) {
        return Response.json(CHILD_B);
      }
      if (path === `/reports/progress/${CHILD_A.id}/periods`) {
        return Response.json({
          child_id: CHILD_A.id,
          items: [
            {
              period_start: progressReportFixture.period_start,
              period_end: progressReportFixture.period_end,
            },
          ],
          next_cursor: null,
        });
      }
      if (path === `/reports/progress/${CHILD_A.id}`) {
        return Response.json({
          ...progressReportFixture,
          child_id: CHILD_A.id,
        });
      }
      if (path === `/reports/progress/${CHILD_A.id}/assessment`) {
        return Response.json({
          child_id: CHILD_A.id,
          period_start: progressReportFixture.period_start,
          period_end: progressReportFixture.period_end,
          overall_score: 85,
          dimensions: [],
          summary: "Tốt",
          recommendations: [],
          source: "deterministic",
        });
      }
      if (path === `/system/difficult-words/${CHILD_A.id}`) {
        return Response.json([difficultWordFixture]);
      }
      if (path === "/reading/history") {
        return Response.json({
          sessions: [],
          next_cursor: null,
        });
      }
      if (path === `/children/${CHILD_A.id}/reading-goals`) {
        return Response.json({ items: [] });
      }
      if (path === `/children/${CHILD_A.id}/reading-plans`) {
        return Response.json({ items: [] });
      }
      if (path === `/children/${CHILD_A.id}/book-collections`) {
        return Response.json({ items: [] });
      }
      if (path === `/children/${CHILD_A.id}/reading-reminders`) {
        return Response.json({ items: [] });
      }
      if (path === `/children/${CHILD_A.id}/reading-reminders/due`) {
        return Response.json({ items: [] });
      }
      if (path === "/books") {
        return Response.json({ items: [], total: 0 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    clearApiReadCache();
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "ProgressReportScreen",
      () => <ProgressReportScreen />,
      () =>
        screen.findByRole("heading", { name: `Tiến bộ của ${CHILD_A.alias}` }),
    ],
    [
      "DifficultWordsScreen",
      () => <DifficultWordsScreen />,
      () =>
        screen.findByRole("heading", {
          name: `Từ cần luyện của ${CHILD_A.alias}`,
        }),
    ],
    [
      "SessionHistoryScreen",
      () => <SessionHistoryScreen page={1} />,
      () => screen.findByRole("heading", { name: "Lịch sử đọc" }),
    ],
    [
      "ReadingManagementScreen",
      () => <ReadingManagementScreen />,
      () => screen.findByRole("heading", { name: "Quản lý đọc sách" }),
    ],
  ])(
    "%s syncs loaded childA once and does NOT revert external AppStore switch to childB or clear",
    async (_name, renderScreen, waitReady) => {
      const user = userEvent.setup();
      const authService = createAuthServiceFixture();

      render(
        withAuthFixture(
          <AppServicesProvider>
            <AppStoreProvider>
              <TopBarSwitcherHarness />
              {renderScreen()}
            </AppStoreProvider>
          </AppServicesProvider>,
          authService,
          { session: authSessionFixture },
        ),
      );

      await waitReady();

      await waitFor(() => {
        expect(screen.getByLabelText("Store selected child")).toHaveTextContent(
          CHILD_A.id,
        );
      });
      expect(window.localStorage.getItem(storageKey)).toBe(CHILD_A.id);

      await user.click(
        screen.getByRole("button", { name: "Switch to Child B" }),
      );

      expect(screen.getByLabelText("Store selected child")).toHaveTextContent(
        CHILD_B.id,
      );
      expect(window.localStorage.getItem(storageKey)).toBe(CHILD_B.id);

      await user.click(
        screen.getByRole("button", { name: "Clear child selection" }),
      );

      expect(screen.getByLabelText("Store selected child")).toHaveTextContent(
        "none",
      );
      expect(window.localStorage.getItem(storageKey)).toBeNull();
    },
  );
});
