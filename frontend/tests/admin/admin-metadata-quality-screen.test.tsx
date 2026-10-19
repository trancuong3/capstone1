import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminMetadataQualityScreen } from "@/components/admin/admin-metadata-quality-screen";
import {
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { MetadataQualityDashboardDTO } from "@/types/metadata-quality";

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: { pathname: "/admin/metadata-quality" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

const dashboardFixture: MetadataQualityDashboardDTO = {
  summary: {
    total_books: 12,
    books_with_issues: 3,
    missing_title: 1,
    missing_author: 2,
    invalid_grade_range: 1,
    possible_duplicate_groups: 1,
    books_in_duplicate_groups: 2,
    checked_at: "2026-10-19T10:00:00Z",
  },
  items: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      title: "   ",
      author: null,
      min_grade: 5,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
      issues: ["MISSING_TITLE", "MISSING_AUTHOR", "INVALID_GRADE_RANGE"],
    },
  ],
  total: 1,
  limit: 10,
  offset: 0,
};

describe("AdminMetadataQualityScreen", () => {
  beforeEach(() => {
    navigationMock.pathname = "/admin/metadata-quality";
  });

  it("renders real service summary and metadata issues", async () => {
    const services = createAdminServiceFixture();
    services.metadataQuality.get.mockResolvedValue(dashboardFixture);

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("Chưa có tác giả")).toBeInTheDocument();
    expect(screen.getByText("Khoảng lớp không hợp lệ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Xem chi tiết" })).toHaveAttribute(
      "href",
      "/admin/books/33333333-3333-4333-8333-333333333333",
    );
    expect(services.metadataQuality.get).toHaveBeenCalledWith({
      search: undefined,
      issue_type: undefined,
      lifecycle_status: undefined,
      limit: 10,
      offset: 0,
    });
  });

  it("sends issue filters to the API service", async () => {
    const services = createAdminServiceFixture();
    services.metadataQuality.get.mockResolvedValue(dashboardFixture);
    const user = userEvent.setup();

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));
    await screen.findByRole("heading", { name: "Sách cần kiểm tra" });
    await user.selectOptions(screen.getByLabelText("Loại vấn đề"), "MISSING_AUTHOR");

    await waitFor(() => {
      expect(services.metadataQuality.get).toHaveBeenLastCalledWith({
        search: undefined,
        issue_type: "MISSING_AUTHOR",
        lifecycle_status: undefined,
        limit: 10,
        offset: 0,
      });
    });
  });

  it("shows a safe error and allows retry", async () => {
    const services = createAdminServiceFixture();
    services.metadataQuality.get
      .mockRejectedValueOnce(new Error("database-private-detail"))
      .mockResolvedValueOnce({ ...dashboardFixture, items: [], total: 0 });
    const user = userEvent.setup();

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));

    expect(
      await screen.findByText("Không thể tải dữ liệu chất lượng metadata"),
    ).toBeInTheDocument();
    expect(screen.queryByText("database-private-detail")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    await waitFor(() => {
      expect(services.metadataQuality.get).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("Chưa phát hiện vấn đề metadata")).toBeInTheDocument();
  });
});
