import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminLayout } from "@/components/admin/admin-layout";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import {
  AdminBadge,
  AdminDrawer,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminStatusBadge,
  AdminToolbar,
} from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { AdminAuthError } from "@/lib/api/admin-auth-service";
import {
  adminBookListItemFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: {
    pathname: "/admin/books",
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: navigationMock.push,
    refresh: navigationMock.refresh,
    replace: navigationMock.replace,
  }),
}));

describe("admin components", () => {
  beforeEach(() => {
    navigationMock.pathname = "/admin/books";
    navigationMock.push.mockClear();
    navigationMock.refresh.mockClear();
    navigationMock.replace.mockClear();
  });

  it("uses Figma-sized buttons inside Admin and preserves the default size elsewhere", async () => {
    const services = createAdminServiceFixture();
    render(
      withAdminFixture(
        <div>
          <AdminLayout>
            <p>Content</p>
          </AdminLayout>
        </div>,
        services,
      ),
    );
    const logout = screen.getByRole("button", { name: "Đăng xuất" });
    expect(logout.className).toContain("min-h-12");
    expect(logout.className).not.toContain("h-16");

    const outsideButton = render(<Button>Parent action</Button>);
    expect(within(outsideButton.container).getByRole("button")).toHaveClass(
      "min-h-14",
    );
  });

  it("uses a safe message when the admin auth service rejects credentials", async () => {
    const services = createAdminServiceFixture();
    services.auth.signIn.mockRejectedValue(
      new AdminAuthError("invalid-credentials"),
    );
    const user = userEvent.setup();
    render(withAdminFixture(<AdminLoginScreen scenario="default" />, services));
    const emailInput = screen.getByLabelText("Email quản trị");
    expect(emailInput).toHaveValue("");
    await user.type(emailInput, "admin@example.com");
    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Thông tin đăng nhập chưa đúng",
    );
    expect(services.auth.signIn).toHaveBeenCalledOnce();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(navigationMock.push).not.toHaveBeenCalled();
  });

  it("returns to a safe admin deep link after login and blocks unsafe or cross-role next targets", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    const { unmount } = render(
      withAdminFixture(
        <AdminLoginScreen
          nextPath="/admin/parents?page=3"
          scenario="default"
        />,
        services,
      ),
    );
    await user.type(
      screen.getByLabelText("Email quản trị"),
      "admin@example.com",
    );
    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() =>
      expect(navigationMock.replace).toHaveBeenCalledWith(
        "/admin/parents?page=3",
      ),
    );
    unmount();

    navigationMock.replace.mockClear();
    const second = render(
      withAdminFixture(
        <AdminLoginScreen nextPath="/dashboard" scenario="default" />,
        services,
      ),
    );
    await user.type(
      screen.getByLabelText("Email quản trị"),
      "admin@example.com",
    );
    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() =>
      expect(navigationMock.replace).toHaveBeenCalledWith("/admin/books"),
    );
    second.unmount();

    navigationMock.replace.mockClear();
    render(
      withAdminFixture(
        <AdminLoginScreen nextPath="//evil.example/admin" scenario="default" />,
        services,
      ),
    );
    await user.type(
      screen.getByLabelText("Email quản trị"),
      "admin@example.com",
    );
    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() =>
      expect(navigationMock.replace).toHaveBeenCalledWith("/admin/books"),
    );
  });

  it("awaits admin sign-out, blocks repeats, and replaces the protected route", async () => {
    const services = createAdminServiceFixture();
    let completeSignOut: () => void = () => undefined;
    services.auth.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSignOut = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminLayout>
          <p>Nội dung quản trị</p>
        </AdminLayout>,
        services,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Đăng xuất" }));
    expect(services.auth.signOut).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Đang đăng xuất…" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Đang đăng xuất…" }));
    expect(services.auth.signOut).toHaveBeenCalledOnce();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    await act(async () => {
      completeSignOut();
    });
    await waitFor(() =>
      expect(navigationMock.replace).toHaveBeenCalledWith("/admin/login"),
    );
    expect(navigationMock.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the protected route visible when admin sign-out fails", async () => {
    const services = createAdminServiceFixture();
    services.auth.signOut.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminLayout>
          <p>Nội dung quản trị</p>
        </AdminLayout>,
        services,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Đăng xuất" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Chưa thể đăng xuất lúc này");
    expect(alert).not.toHaveTextContent("provider unavailable");
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(navigationMock.refresh).not.toHaveBeenCalled();
  });

  it("rejects an inverted grade range in the book form", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    render(<AdminBookForm onSubmit={submit} />);
    await user.type(screen.getByLabelText("Tên sách *"), "Tên mới");
    await user.type(screen.getByLabelText("Tiêu đề sách *"), "Sách mới");
    await user.selectOptions(screen.getByLabelText("Khối lớp nhỏ nhất *"), "5");
    await user.selectOptions(screen.getByLabelText("Khối lớp lớn nhất *"), "2");
    await user.click(screen.getByRole("button", { name: "Lưu sách" }));
    expect(await screen.findByText(/không được lớn hơn/)).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("offers title repair and metadata editing directly from the inventory", async () => {
    const services = createAdminServiceFixture();
    const missingTitle = {
      ...adminBookListItemFixture,
      book: {
        ...adminBookListItemFixture.book,
        id: "81000000-0000-4000-8000-000000000099",
        title: "",
      },
    };
    services.books.list.mockResolvedValue([
      missingTitle,
      adminBookListItemFixture,
    ]);
    render(withAdminFixture(<AdminBooksScreen />, services));

    expect(
      await screen.findByRole("link", { name: "Bổ sung tiêu đề" }),
    ).toHaveAttribute(
      "href",
      `/admin/books/${missingTitle.book.id}/edit?issue=MISSING_TITLE`,
    );

    expect(
      screen.getByRole("link", { name: "Chỉnh sửa thông tin" }),
    ).toHaveAttribute(
      "href",
      `/admin/books/${adminBookListItemFixture.book.id}/edit`,
    );
  });

  it("retires a book from the inventory and reloads the lifecycle from the service", async () => {
    const services = createAdminServiceFixture();
    const retired = {
      ...adminBookListItemFixture,
      book: {
        ...adminBookListItemFixture.book,
        lifecycle_status: "RETIRED" as const,
      },
      parent_catalog_eligible: false,
    };
    services.books.list
      .mockResolvedValueOnce([adminBookListItemFixture])
      .mockResolvedValueOnce([retired]);
    services.books.updateStatus.mockResolvedValue({
      ...adminBookListItemFixture.book,
      lifecycle_status: "RETIRED",
    });
    const user = userEvent.setup();

    render(withAdminFixture(<AdminBooksScreen />, services));
    await screen.findByRole("button", { name: "Ngừng hoạt động" });
    await user.click(screen.getByRole("button", { name: "Ngừng hoạt động" }));
    await user.click(
      await screen.findByRole("button", { name: "Xác nhận ngừng hoạt động" }),
    );

    await waitFor(() => {
      expect(services.books.updateStatus).toHaveBeenCalledWith(
        adminBookListItemFixture.book.id,
        { status: "RETIRED" },
      );
    });
    expect(
      await screen.findByRole("button", { name: "Kích hoạt lại" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Đã ngừng")).toBeInTheDocument();
    expect(
      await screen.findByText("Đã ngừng hoạt động sách"),
    ).toBeInTheDocument();
  });

  it("renders lifecycle and OCR metrics from typed service responses and forwards filters", async () => {
    const services = createAdminServiceFixture();
    const retired = {
      ...adminBookListItemFixture,
      book: {
        ...adminBookListItemFixture.book,
        lifecycle_status: "RETIRED" as const,
      },
      parent_catalog_eligible: false,
    };
    const user = userEvent.setup();
    render(withAdminFixture(<AdminBooksScreen />, services));
    await screen.findByRole("heading", {
      name: adminBookListItemFixture.book.title,
    });
    expect(
      screen.getByText("Đang hoạt động", { exact: true }),
    ).toBeInTheDocument();
    const pageStatus = screen.getByLabelText("Trạng thái trang sách");
    expect(pageStatus).toHaveTextContent("3 trang");
    expect(pageStatus).toHaveTextContent(
      `Cần duyệt ${adminBookListItemFixture.needs_review_count}`,
    );
    expect(pageStatus).toHaveTextContent(
      `Đang xử lý ${adminBookListItemFixture.processing_count}`,
    );
    expect(pageStatus).toHaveTextContent(
      `Đã duyệt ${adminBookListItemFixture.verified_count}`,
    );
    services.books.list.mockResolvedValueOnce([retired]);
    await user.selectOptions(screen.getByLabelText("Vòng đời"), "RETIRED");
    expect(await screen.findByText("Đã ngừng")).toBeInTheDocument();
    expect(services.books.list).toHaveBeenLastCalledWith({
      search: "",
      lifecycle_status: "RETIRED",
      verification_status: undefined,
    });
    expect(services.books.create).not.toHaveBeenCalled();
    expect(services.books.update).not.toHaveBeenCalled();
  });

  it("defaults buttons inside AdminLayout to compact admin size with w-auto and supports outline variants", () => {
    const services = createAdminServiceFixture();
    render(
      withAdminFixture(
        <AdminLayout>
          <Button variant="outline">Chỉnh sửa</Button>
          <Button variant="destructive-outline">Xóa mục</Button>
          <Button fullWidth>Lưu tất cả</Button>
          <ButtonLink href="/admin/books/new">Tạo mới</ButtonLink>
        </AdminLayout>,
        services,
      ),
    );

    const outlineBtn = screen.getByRole("button", { name: "Chỉnh sửa" });
    expect(outlineBtn.className).toContain("min-h-10");
    expect(outlineBtn.className).toContain("w-auto");
    expect(outlineBtn.className).toContain("border-border");
    expect(outlineBtn.className).not.toContain("w-full");

    const destructiveOutlineBtn = screen.getByRole("button", {
      name: "Xóa mục",
    });
    expect(destructiveOutlineBtn.className).toContain("border-danger/30");
    expect(destructiveOutlineBtn.className).toContain("text-danger");

    const fullWidthBtn = screen.getByRole("button", { name: "Lưu tất cả" });
    expect(fullWidthBtn.className).toContain("w-full");

    const linkBtn = screen.getByRole("link", { name: "Tạo mới" });
    expect(linkBtn.className).toContain("min-h-10");
    expect(linkBtn.className).toContain("w-auto");

    // Grouped desktop navigation sections in AdminLayout
    const desktopNav = screen.getByRole("navigation", {
      name: "Điều hướng quản trị",
    });
    expect(within(desktopNav).getByText("Nội dung")).toBeInTheDocument();
    expect(within(desktopNav).getByText("Người dùng")).toBeInTheDocument();
    expect(within(desktopNav).getByText("Hệ thống & AI")).toBeInTheDocument();
  });

  it("renders Admin UI primitives with accessible controls, interactive KPIs, and Escape-closable drawer", async () => {
    const user = userEvent.setup();
    const onKpiClick = vi.fn();
    const onSearchChange = vi.fn();
    const onSelectChange = vi.fn();
    const onDrawerClose = vi.fn();

    render(
      <div>
        <AdminPageHeader
          actions={<Button size="admin">Thêm</Button>}
          breadcrumbs={[
            { label: "Kho sách", href: "/admin/books" },
            { label: "Chi tiết" },
          ]}
          description="Mô tả ngắn"
          eyebrow="Quản trị nội dung"
          title="Tiêu đề trang"
        />
        <AdminBadge dot tone="info">
          Đang đồng bộ
        </AdminBadge>
        <AdminStatusBadge label="Chế độ chờ" tone="neutral" />
        <AdminKpiGrid ariaLabel="Chỉ số chính" columns={2}>
          <AdminKpiCard
            active
            label="Tổng sách"
            onClick={onKpiClick}
            testId="kpi-total"
            tone="info"
            value={42}
          />
          <AdminKpiCard label="Cần duyệt" tone="warning" value={5} />
        </AdminKpiGrid>
        <AdminToolbar ariaLabel="Bộ lọc">
          <AdminSearchInput
            label="Tìm kiếm"
            onChange={onSearchChange}
            placeholder="Nhập từ khóa…"
            value="mèo"
          />
          <AdminSelect
            label="Trạng thái"
            onChange={onSelectChange}
            options={[
              { value: "", label: "Tất cả" },
              { value: "ACTIVE", label: "Hoạt động" },
            ]}
            value=""
          />
        </AdminToolbar>
        <AdminLoading label="Đang nạp…" variant="skeleton" />
        <AdminDrawer
          description="Chi tiết tác vụ"
          footer={<Button size="admin">Đóng lại</Button>}
          isOpen
          onClose={onDrawerClose}
          title="Ngăn kéo chi tiết"
        >
          <p>Nội dung ngăn kéo</p>
        </AdminDrawer>
      </div>,
    );

    expect(screen.getByRole("link", { name: "Kho sách" })).toHaveAttribute(
      "href",
      "/admin/books",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Tiêu đề trang" })
        .className,
    ).toContain("text-2xl");
    expect(screen.getByText("Đang đồng bộ")).toBeInTheDocument();
    expect(screen.getByText("Chế độ chờ")).toBeInTheDocument();

    const kpiButton = screen.getByTestId("kpi-total");
    expect(kpiButton).toHaveAttribute("aria-pressed", "true");
    await user.click(kpiButton);
    expect(onKpiClick).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Xóa từ khóa tìm kiếm" }),
    );
    expect(onSearchChange).toHaveBeenCalledWith("");

    await user.selectOptions(screen.getByLabelText("Trạng thái"), "ACTIVE");
    expect(onSelectChange).toHaveBeenCalledWith("ACTIVE");

    const drawer = screen.getByRole("dialog", { name: "Ngăn kéo chi tiết" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer.className).toContain("border-s");

    await user.keyboard("{Escape}");
    expect(onDrawerClose).toHaveBeenCalledOnce();
  });

  it("keeps focus inside AdminDrawer inputs when parent re-renders with an inline onClose handler", async () => {
    const user = userEvent.setup();
    const onFinalClose = vi.fn();

    function ControlledDrawerHarness() {
      const [note, setNote] = useState("");
      return (
        <AdminDrawer
          isOpen
          onClose={() => onFinalClose(note)}
          title="Ghi chú kiểm duyệt"
        >
          <label htmlFor="drawer-note">Ghi chú</label>
          <input
            id="drawer-note"
            onChange={(event) => setNote(event.target.value)}
            value={note}
          />
        </AdminDrawer>
      );
    }

    render(<ControlledDrawerHarness />);
    const noteInput = screen.getByLabelText("Ghi chú");
    await user.click(noteInput);
    await user.type(noteInput, "abc");

    expect(noteInput).toHaveValue("abc");
    expect(noteInput).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onFinalClose).toHaveBeenCalledWith("abc");
  });

  it("forwards the title tooltip prop on AdminBadge for truncated audit action labels", () => {
    const actionName = "admin.book.metadata.quality.update";
    render(
      <AdminBadge
        className="max-w-full overflow-hidden font-mono"
        dot
        title={actionName}
        tone="warning"
      >
        <span className="min-w-0 truncate">{actionName}</span>
      </AdminBadge>,
    );

    const innerText = screen.getByText(actionName);
    expect(innerText).toHaveClass("min-w-0", "truncate");
    const badge = innerText.parentElement;
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("title", actionName);
    expect(badge).toHaveClass("overflow-hidden");
  });

  it("renders AdminSelect with a single custom chevron and keeps the native select overlaid invisibly", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AdminSelect
        label="Trạng thái lọc"
        options={[
          { value: "", label: "Tất cả" },
          { value: "ACTIVE", label: "Hoạt động" },
        ]}
        style={{ minWidth: "160px" }}
        defaultValue=""
      />,
    );

    const select = screen.getByLabelText("Trạng thái lọc");
    expect(select).toHaveClass("opacity-0", "appearance-none");

    const control = container.querySelector(
      '[data-admin-select-control="true"]',
    );
    expect(control).not.toBeNull();
    expect((control as HTMLElement).style.minWidth).toBe("160px");

    const valueDisplay = container.querySelector(
      '[data-admin-select-value="true"]',
    );
    expect(valueDisplay).toHaveTextContent("Tất cả");

    await user.selectOptions(select, "ACTIVE");
    expect(valueDisplay).toHaveTextContent("Hoạt động");

    const childrenSelect = render(
      <AdminSelect label="Chế độ con" value="NEEDS_REVIEW">
        <option value="">Tất cả chế độ</option>
        <option value="NEEDS_REVIEW">Cần kiểm tra</option>
      </AdminSelect>,
    );
    expect(
      childrenSelect.container.querySelector(
        '[data-admin-select-value="true"]',
      ),
    ).toHaveTextContent("Cần kiểm tra");

    const icons = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(icons).toHaveLength(1);
  });
});
