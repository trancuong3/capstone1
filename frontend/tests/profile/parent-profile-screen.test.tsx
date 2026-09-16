import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ParentProfileScreen } from "@/components/profile/parent-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import type { AppMockScenario } from "@/types/ui-state";

function renderProfile(scenario: AppMockScenario = "default") {
  return render(
    <AppStoreProvider>
      <AppServicesProvider scenario={scenario}>
        <ParentProfileScreen />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}

describe("ParentProfileScreen", () => {
  it("renders only fields from ParentProfileDTO", async () => {
    renderProfile();

    expect(
      await screen.findByRole("heading", { name: "Nguyễn Minh Anh" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Phụ huynh")).toHaveLength(2);
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it("validates and updates the permitted display name", async () => {
    const user = userEvent.setup();
    renderProfile();

    await user.click(
      await screen.findByRole("button", { name: "Chỉnh sửa hồ sơ" }),
    );
    const displayName = screen.getByLabelText("Tên hiển thị của ba mẹ");
    await user.clear(displayName);
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập tên hiển thị."),
    ).toBeInTheDocument();

    await user.clear(displayName);
    await user.type(displayName, "Ba Mẹ Mây");
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Đã cập nhật hồ sơ",
    );
    expect(
      screen.getByRole("heading", { name: "Ba Mẹ Mây" }),
    ).toBeInTheDocument();
  });

  it("keeps load errors generic", async () => {
    renderProfile("error");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
  });

  it("exposes an accessible loading state", () => {
    renderProfile("loading");

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
  });
});
