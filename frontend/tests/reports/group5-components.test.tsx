import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { DifficultWordItem } from "@/components/reports/difficult-word-item";
import { MetricCard } from "@/components/reports/metric-card";
import { ProgressChart } from "@/components/reports/progress-chart";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { MOCK_CURRENT_CHILD_ID } from "@/lib/mock/mock-app-store";
import {
  MOCK_DIFFICULT_WORDS,
  MOCK_PROGRESS_REPORTS,
  MOCK_REPORT_SESSION_ID,
} from "@/lib/mock/mock-report-data";

function Services({ children }: { readonly children: React.ReactNode }) {
  return (
    <AppStoreProvider>
      <AppServicesProvider scenario="default">{children}</AppServicesProvider>
    </AppStoreProvider>
  );
}

describe("Group 5 report components", () => {
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

  it("renders a textual table summary for the visual chart", () => {
    render(<ProgressChart report={MOCK_PROGRESS_REPORTS[0]} />);
    expect(
      screen.getByRole("table", {
        name: "Tóm tắt dạng bảng của biểu đồ bằng chứng đọc",
      }),
    ).toBeInTheDocument();
  });

  it("shows historical revision and nullable fluency score", async () => {
    render(
      <Services>
        <SessionDetailScreen sessionId={MOCK_REPORT_SESSION_ID} />
      </Services>,
    );
    expect(await screen.findByText("Chưa đánh giá")).toBeInTheDocument();
    expect(
      screen.getAllByText("40000000-0000-4000-8000-900000000014").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Sự kiện trong buổi đọc")).toBeInTheDocument();
  });

  it("practices with text-only mock feedback and no evidence claim", async () => {
    const user = userEvent.setup();
    render(
      <Services>
        <DifficultWordItem
          childId={MOCK_CURRENT_CHILD_ID}
          word={MOCK_DIFFICULT_WORDS[0]}
        />
      </Services>,
    );
    await user.click(screen.getByRole("button", { name: "Luyện từ" }));
    expect(
      await screen.findByText(
        /Đây là mô phỏng chữ, không phát TTS thật và không thêm bằng chứng/,
      ),
    ).toBeInTheDocument();
  });
});
