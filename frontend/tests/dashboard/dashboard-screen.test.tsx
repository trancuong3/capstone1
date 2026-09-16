import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import type { AppMockScenario } from "@/types/ui-state";

function renderDashboard(scenario: AppMockScenario = "default") {
  return render(
    <AppStoreProvider>
      <AppServicesProvider scenario={scenario}>
        <DashboardScreen />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}

describe("DashboardScreen", () => {
  it("shows only the current parent's child profiles and book navigation", async () => {
    renderDashboard();

    expect(
      await screen.findByRole("heading", {
        name: /Chào Nguyễn Minh Anh/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bé An, lớp 2" })).toHaveAttribute(
      "href",
      "/books?childId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(
      screen.getByRole("link", { name: "Bé Minh, lớp 4" }),
    ).toHaveAttribute(
      "href",
      "/books?childId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(screen.queryByText("Hồ sơ riêng tư")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chọn sách" })).toHaveAttribute(
      "href",
      "/books",
    );
    expect(screen.getByRole("link", { name: "Tạo hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children/new",
    );
  });

  it("shows the first-child action for an empty account", async () => {
    renderDashboard("empty");

    expect(
      await screen.findByRole("heading", {
        name: "Gia đình mình chưa có hồ sơ bé",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Tạo hồ sơ đầu tiên" }),
    ).toHaveAttribute("href", "/children/new");
  });

  it("keeps service errors generic", async () => {
    renderDashboard("error");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
  });

  it("exposes an accessible loading state", () => {
    renderDashboard("loading");

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
  });
});
