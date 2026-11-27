import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminMetadataQualityScreen } from "@/components/admin/admin-metadata-quality-screen";
import {
  AdminQualityHubScreen,
  parseQualityHubTab,
} from "@/components/admin/admin-quality-hub-screen";
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
    const desktopTable = screen.getByRole("region", {
      name: "Bảng sách cần kiểm tra metadata",
    });
    const mobileList = screen.getByLabelText(
      "Danh sách sách cần kiểm tra metadata trên di động",
    );
    expect(
      within(desktopTable).getByText("Chưa có tiêu đề"),
    ).toBeInTheDocument();
    expect(within(mobileList).getByText("Chưa có tiêu đề")).toBeInTheDocument();
    expect(screen.getAllByText("Chưa có tác giả").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Khoảng lớp không hợp lệ").length,
    ).toBeGreaterThan(0);
    expect(
      within(desktopTable).getByRole("link", { name: "Bổ sung metadata" }),
    ).toHaveAttribute(
      "href",
      "/admin/books/33333333-3333-4333-8333-333333333333/edit?returnTo=metadata-quality&issue=MISSING_TITLE",
    );
    expect(
      within(mobileList).getByRole("link", { name: "Bổ sung metadata" }),
    ).toHaveAttribute(
      "href",
      "/admin/books/33333333-3333-4333-8333-333333333333/edit?returnTo=metadata-quality&issue=MISSING_TITLE",
    );
    expect(
      within(desktopTable).getByRole("link", { name: "So sánh sách" }),
    ).toHaveAttribute(
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

    const desktopTable = await screen.findByRole("region", {
      name: "Bảng sách cần kiểm tra metadata",
    });
    expect(
      within(desktopTable).getByText("Chưa có tiêu đề"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Đã ngừng").length).toBeGreaterThan(0);
    expect(
      within(desktopTable).getByRole("link", { name: "Bổ sung metadata" }),
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
      await screen.findByText("Đang xem 11–20 / 21 kết quả"),
    ).toBeInTheDocument();
  });
});

describe("AdminQualityHubScreen", () => {
  it("renders a single h1 header with 4 segmented tabs, supports ?tab parsing, and has unique DOM IDs", async () => {
    expect(parseQualityHubTab(undefined)).toBe("metadata");
    expect(parseQualityHubTab("unknown")).toBe("metadata");
    expect(parseQualityHubTab("reports")).toBe("reports");
    expect(parseQualityHubTab("approval")).toBe("approval");
    expect(parseQualityHubTab("user-books")).toBe("user-books");

    const services = createAdminServiceFixture();
    vi.mocked(services.metadataQuality.get).mockResolvedValue(dashboardFixture);
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: { OPEN: 0, UNDER_REVIEW: 0, RESOLVED: 0, REJECTED: 0 },
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listUserBooks!).mockResolvedValue({
      items: [],
      total: 0,
      summary: { PENDING_ADMIN: 0 },
      limit: 30,
      offset: 0,
    });

    const user = userEvent.setup();
    const { container } = render(
      withAdminFixture(
        <AdminQualityHubScreen initialTab="metadata" />,
        services,
      ),
    );

    expect(await screen.findByText("12")).toBeInTheDocument();
    // Single unified H1 — no duplicate stacked headers
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    // Switch across reports -> approval -> user-books and assert unique IDs
    await user.click(screen.getByRole("tab", { name: "Báo cáo người dùng" }));
    expect(
      await screen.findByRole("heading", { name: "Báo cáo từ phụ huynh" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Duyệt & An toàn sách" }));
    expect(
      await screen.findByRole("heading", {
        name: "Kiểm tra nội dung toàn sách",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Sách người dùng/ }));
    expect(
      await screen.findByRole("heading", {
        name: "Hàng đợi kiểm duyệt Sách người dùng",
      }),
    ).toBeInTheDocument();

    // Verify ZERO duplicate IDs in DOM
    const idElements = Array.from(container.querySelectorAll("[id]"));
    const ids = idElements.map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
