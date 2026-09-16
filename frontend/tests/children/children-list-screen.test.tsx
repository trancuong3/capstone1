import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChildrenListScreen } from "@/components/children/children-list-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import type { AppMockScenario } from "@/types/ui-state";

function renderChildren(scenario: AppMockScenario = "default") {
  return render(
    <AppStoreProvider>
      <AppServicesProvider scenario={scenario}>
        <ChildrenListScreen />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}

describe("ChildrenListScreen", () => {
  it("shows only child profiles owned by the current parent", async () => {
    renderChildren();

    expect(await screen.findByText("Bé An")).toBeInTheDocument();
    expect(screen.getByText("Bé Minh")).toBeInTheDocument();
    expect(screen.queryByText("Hồ sơ riêng tư")).not.toBeInTheDocument();
    expect(screen.getAllByText("Xem và chỉnh sửa")).toHaveLength(2);
  });

  it("shows the empty state and create action", async () => {
    renderChildren("empty");

    expect(
      await screen.findByRole("heading", { name: "Chưa có hồ sơ bé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Tạo hồ sơ đầu tiên" }),
    ).toHaveAttribute("href", "/children/new");
  });

  it("keeps service failures generic", async () => {
    renderChildren("error");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
  });

  it("exposes an accessible loading state", () => {
    renderChildren("loading");

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
  });
});
