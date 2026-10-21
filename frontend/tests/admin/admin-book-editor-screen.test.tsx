import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { AdminBookEditorScreen } from "@/components/admin/admin-book-editor-screen";
import {
  adminBookFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import { ServiceError } from "@/lib/api/service-error";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

describe("AdminBookEditorScreen", () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads real service data and updates metadata before navigating back", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.get).mockResolvedValue(adminBookFixture);
    vi.mocked(services.books.update).mockResolvedValue({
      ...adminBookFixture,
      title: "Tên sách đã sửa",
    });
    const user = userEvent.setup();

    render(
      withAdminFixture(
        <AdminBookEditorScreen bookId={adminBookFixture.id} />,
        services,
      ),
    );

    const title = await screen.findByRole("textbox", {
      name: "Tiêu đề sách *",
    });
    expect(title).toHaveValue(adminBookFixture.title);
    await user.clear(title);
    await user.type(title, "Tên sách đã sửa");
    await user.click(screen.getByRole("button", { name: "Lưu metadata" }));

    await waitFor(() => {
      expect(services.books.update).toHaveBeenCalledWith(adminBookFixture.id, {
        title: "Tên sách đã sửa",
        author: adminBookFixture.author,
        min_grade: 1,
        max_grade: 3,
      });
    });
    expect(routerMock.push).toHaveBeenCalledWith(
      `/admin/books/${adminBookFixture.id}`,
    );
    expect(routerMock.refresh).toHaveBeenCalledOnce();
  });

  it("returns to the metadata dashboard after fixing a flagged field", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.get).mockResolvedValue(adminBookFixture);
    vi.mocked(services.books.update).mockResolvedValue({
      ...adminBookFixture,
      title: "Đã bổ sung tiêu đề",
    });

    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminBookEditorScreen
          bookId={adminBookFixture.id}
          issue="MISSING_TITLE"
          returnTo="metadata-quality"
        />,
        services,
      ),
    );

    const title = await screen.findByRole("textbox", {
      name: "Tiêu đề sách *",
    });
    await user.clear(title);
    await user.type(title, "Đã bổ sung tiêu đề");
    await user.click(screen.getByRole("button", { name: "Lưu metadata" }));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/admin/metadata-quality");
    });
    expect(services.books.update).toHaveBeenCalledOnce();
  });

  it("retires only through the lifecycle API after confirmation", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.get).mockResolvedValue(adminBookFixture);
    vi.mocked(services.books.updateStatus).mockResolvedValue({
      ...adminBookFixture,
      lifecycle_status: "RETIRED",
    });
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const user = userEvent.setup();

    render(
      withAdminFixture(
        <AdminBookEditorScreen bookId={adminBookFixture.id} />,
        services,
      ),
    );
    await screen.findByRole("textbox", { name: "Tiêu đề sách *" });
    await user.click(screen.getByRole("button", { name: "Ngừng hoạt động" }));

    await waitFor(() => {
      expect(services.books.updateStatus).toHaveBeenCalledWith(
        adminBookFixture.id,
        { status: "RETIRED" },
      );
    });
    expect(
      await screen.findByRole("button", { name: "Kích hoạt lại" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/lịch sử đọc vẫn được giữ nguyên/),
    ).toBeInTheDocument();
  });

  it("does not claim reactivation when the backend rejects invalid metadata", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.get).mockResolvedValue({
      ...adminBookFixture,
      lifecycle_status: "RETIRED",
    });
    vi.mocked(services.books.updateStatus).mockRejectedValue(
      new ServiceError({
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        status: 422,
        request_id: "test-request",
        retryable: false,
      }),
    );
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const user = userEvent.setup();

    render(
      withAdminFixture(
        <AdminBookEditorScreen bookId={adminBookFixture.id} />,
        services,
      ),
    );
    await screen.findByRole("textbox", { name: "Tiêu đề sách *" });
    await user.click(screen.getByRole("button", { name: "Kích hoạt lại" }));

    expect(
      await screen.findByText(/Metadata hiện tại chưa hợp lệ/),
    ).toBeInTheDocument();
    expect(services.books.updateStatus).toHaveBeenCalledWith(
      adminBookFixture.id,
      { status: "ACTIVE" },
    );
  });
});
