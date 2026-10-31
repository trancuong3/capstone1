import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { DifficultWordItem } from "@/components/reports/difficult-word-item";
import { MetricCard } from "@/components/reports/metric-card";
import { ProgressChart } from "@/components/reports/progress-chart";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import {
  TEST_CHILD_ID,
  TEST_SESSION_ID,
  TEST_REVISION_ID,
  childFixture,
  bookFixture,
  sessionDetailFixture,
  difficultWordFixture,
  progressReportFixture,
} from "@/test/fixtures/report-data-fixture";

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
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

describe("Report components with typed data and real API adapters", () => {
  it("uses a non-orphaned heading level for a report metric", () => {
    render(
      <MetricCard
        metric={{
          hint: "Compared with last week",
          id: "sessions",
          label: "Completed sessions",
          unavailable: false,
          value: "4",
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Completed sessions" }),
    ).toBeInTheDocument();
  });

  it("renders matching numerical values in the chart's accessible table", () => {
    render(<ProgressChart report={progressReportFixture} />);
    const table = screen.getByRole("table", {
      name: "Tóm tắt dạng bảng của biểu đồ bằng chứng đọc",
    });
    expect(table.parentElement).toHaveClass("sr-only");
    expect(
      within(table).getByRole("row", { name: "Bỏ sót 2" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("row", { name: "Lặp từ 1" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("row", { name: "Dừng lâu 0" }),
    ).toBeInTheDocument();
  });

  it("shows stored historical revision and unavailable fluency score through real services", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/reading/history/${TEST_SESSION_ID}`)
        return Response.json(sessionDetailFixture);
      if (path === `/reading/history/${TEST_SESSION_ID}/book`)
        return Response.json(bookFixture);
      if (path === `/profiles/children/${TEST_CHILD_ID}`)
        return Response.json(childFixture);
      throw new Error("Unexpected isolated report route");
    });
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    expect(await screen.findByText("Chưa đánh giá")).toBeInTheDocument();
    expect(screen.getAllByText(TEST_REVISION_ID).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "Sự kiện trong buổi đọc" }),
    ).toBeInTheDocument();
    expect(requestedApiUrl().pathname).toBe(
      `/reading/history/${TEST_SESSION_ID}`,
    );
    expect(apiFetchFixture).toHaveBeenCalledTimes(3);
  });

  it("reports unavailable practice without audio playback, API writes or evidence claims", async () => {
    const user = userEvent.setup();
    const snapshot = structuredClone(difficultWordFixture);
    render(
      <AppServicesProvider>
        <DifficultWordItem
          childId={TEST_CHILD_ID}
          word={difficultWordFixture}
        />
      </AppServicesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Luyện từ" }));
    expect(
      await screen.findByText(
        "Chức năng luyện từ chưa sẵn sàng. Chưa phát âm thanh hoặc thêm bằng chứng.",
      ),
    ).toBeInTheDocument();
    expect(apiFetchFixture).not.toHaveBeenCalled();
    expect(difficultWordFixture).toEqual(snapshot);
    expect(screen.getByRole("button", { name: "Luyện từ" })).toBeEnabled();
  });
});
