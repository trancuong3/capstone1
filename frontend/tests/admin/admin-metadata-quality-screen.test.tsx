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
      issues: [
        "MISSING_TITLE",
        "MISSING_AUTHOR",
        "INVALID_GRADE_RANGE",
        "POSSIBLE_DUPLICATE",
      ],
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
    vi.mocked(services.metadataQuality.get).mockResolvedValue(dashboardFixture);

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(await screen.findByText("Chưa có tiêu đề")).toBeInTheDocument();
    expect(screen.getAllByText("Chưa có tác giả").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Khoảng lớp không hợp lệ").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Bổ sung metadata" }),
    ).toHaveAttribute(
      "href",
      "/admin/books/33333333-3333-4333-8333-333333333333/edit?returnTo=metadata-quality&issue=MISSING_TITLE",
    );
    expect(screen.getByRole("link", { name: "So sánh sách" })).toHaveAttribute(
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

  it("shows retired books with NULL titles so Admin can repair their metadata", async () => {
    const services = createAdminServiceFixture();
    const retiredBookId = "44444444-4444-4444-8444-444444444444";
    vi.mocked(services.metadataQuality.get).mockResolvedValue({
      ...dashboardFixture,
      summary: { ...dashboardFixture.summary, missing_title: 1 },
      items: [
        {
          id: retiredBookId,
          title: null,
          author: "Tác giả",
          min_grade: 1,
          max_grade: 3,
          lifecycle_status: "RETIRED",
          issues: ["MISSING_TITLE"],
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));

    expect(await screen.findByText("Chưa có tiêu đề")).toBeInTheDocument();
    expect(screen.getByText("Đã ngừng")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Bổ sung metadata" }),
    ).toHaveAttribute(
      "href",
      `/admin/books/${retiredBookId}/edit?returnTo=metadata-quality&issue=MISSING_TITLE`,
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
    vi.mocked(services.metadataQuality.get).mockResolvedValue(dashboardFixture);
    const user = userEvent.setup();

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));
    await screen.findByRole("heading", { name: "Sách cần kiểm tra" });
    await user.selectOptions(
      screen.getByLabelText("Loại vấn đề"),
      "MISSING_TITLE",
    );

    await waitFor(() => {
      expect(services.metadataQuality.get).toHaveBeenLastCalledWith({
        search: undefined,
        issue_type: "MISSING_TITLE",
        lifecycle_status: undefined,
        limit: 10,
        offset: 0,
      });
    });
  });

  it("shows a safe error and allows retry", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.metadataQuality.get)
      .mockRejectedValueOnce(new Error("database-private-detail"))
      .mockResolvedValueOnce({
        ...dashboardFixture,
        summary: { ...dashboardFixture.summary, books_with_issues: 0 },
        items: [],
        total: 0,
      });
    const user = userEvent.setup();

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));

    expect(
      await screen.findByText("Không thể tải dữ liệu chất lượng metadata"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("database-private-detail"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    await waitFor(() => {
      expect(services.metadataQuality.get).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText("Chưa phát hiện vấn đề metadata"),
    ).toBeInTheDocument();
  });

  it("sends search text to the backend service", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.metadataQuality.get).mockResolvedValue(dashboardFixture);
    const user = userEvent.setup();

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));
    await screen.findByRole("heading", { name: "Sách cần kiểm tra" });
    await user.type(
      screen.getByRole("textbox", { name: "Tìm theo tiêu đề hoặc tác giả" }),
      "Sách",
    );

    await waitFor(() => {
      expect(services.metadataQuality.get).toHaveBeenLastCalledWith({
        search: "Sách",
        issue_type: undefined,
        lifecycle_status: undefined,
        limit: 10,
        offset: 0,
      });
    });
  });

  it("requests the next backend page instead of paging a local array", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.metadataQuality.get)
      .mockResolvedValueOnce({ ...dashboardFixture, total: 21 })
      .mockResolvedValueOnce({
        ...dashboardFixture,
        items: [],
        total: 21,
        offset: 10,
      });
    const user = userEvent.setup();

    render(withAdminFixture(<AdminMetadataQualityScreen />, services));
    await screen.findByRole("heading", { name: "Sách cần kiểm tra" });
    await user.click(screen.getByRole("button", { name: "Tiếp" }));

    await waitFor(() => {
      expect(services.metadataQuality.get).toHaveBeenLastCalledWith({
        search: undefined,
        issue_type: undefined,
        lifecycle_status: undefined,
        limit: 10,
        offset: 10,
      });
    });
    expect(
      await screen.findByText("Hiển thị 11–20 trên 21 kết quả"),
    ).toBeInTheDocument();
  });
});
