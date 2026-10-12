import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminParentDetailScreen } from "@/components/admin/admin-parent-detail-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import { ServiceError } from "@/lib/api/service-error";

const PARENT_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_ID = "33333333-3333-4333-8333-333333333333";

const { getById, update, restore } = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  restore: vi.fn(),
}));

function renderScreen(parentId = PARENT_ID) {
  const services = {
    parents: { getById, update, restore },
  } as unknown as AdminServices;

  return render(
    <AdminServicesContext.Provider value={services}>
      <AdminParentDetailScreen parentId={parentId} />
    </AdminServicesContext.Provider>,
  );
}

const parentDetail = {
  id: PARENT_ID,
  display_name: "Nguyen Van A",
  email: "parent@example.com",
  phone: "0900000000",
  created_at: "2026-10-01T00:00:00Z",
  children: [
    {
      id: CHILD_ID,
      alias: "Be An",
      grade: 2,
      created_at: "2026-10-02T00:00:00Z",
    },
  ],
  contact_info_status: "available" as const,
};

describe("AdminParentDetailScreen", () => {
  beforeEach(() => {
    getById.mockReset();
    update.mockReset();
    restore.mockReset();
  });

  it("renders parent contact information and linked children from the API", async () => {
    getById.mockResolvedValueOnce(parentDetail);

    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Nguyen Van A" }),
    ).toBeInTheDocument();
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(screen.getByText("0900000000")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Be An" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(getById).toHaveBeenCalledWith(
      PARENT_ID,
      expect.any(AbortSignal),
    );
  });

  it("shows missing contact fields without breaking the detail screen", async () => {
    getById.mockResolvedValueOnce({
      ...parentDetail,
      email: null,
      phone: null,
    });

    renderScreen();

    expect(await screen.findAllByText("Chưa cung cấp")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: "Be An" }),
    ).toBeInTheDocument();
  });

  it("explains when server-side Auth contact lookup is not configured", async () => {
    getById.mockResolvedValueOnce({
      ...parentDetail,
      email: null,
      phone: null,
      contact_info_status: "not_configured" as const,
    });

    renderScreen();

    expect(
      await screen.findByText(
        /backend chưa được cấu hình quyền truy xuất Supabase Auth/i,
      ),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("Chưa khả dụng")).toHaveLength(2);
    expect(screen.queryByText("Chưa cung cấp")).not.toBeInTheDocument();
  });

  it("shows an empty state when the parent has no children", async () => {
    getById.mockResolvedValueOnce({ ...parentDetail, children: [] });

    renderScreen();

    expect(
      await screen.findByText("Phụ huynh chưa có hồ sơ trẻ em"),
    ).toBeInTheDocument();
  });

  it("shows a safe not-found state and can return to the directory", async () => {
    getById.mockRejectedValueOnce(
      new ServiceError({
        code: "RESOURCE_NOT_FOUND",
        message: "safe error",
        status: 404,
        request_id: "",
        retryable: false,
      }),
    );

    renderScreen();

    expect(
      await screen.findByText("Không tìm thấy phụ huynh"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Quay lại danh sách/i }),
    ).toHaveAttribute("href", "/admin/parents");
  });

  it("allows retry after a temporary API failure", async () => {
    getById.mockRejectedValueOnce(new Error("internal details"));
    getById.mockResolvedValueOnce(parentDetail);

    renderScreen();

    expect(
      await screen.findByText("Không thể tải thông tin phụ huynh"),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));

    await waitFor(() => expect(getById).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("heading", { name: "Be An" }),
    ).toBeInTheDocument();
  });

  it("updates a Parent from the detail screen through the typed service", async () => {
    getById.mockResolvedValueOnce(parentDetail);
    update.mockResolvedValueOnce({
      ...parentDetail,
      display_name: "Nguyen Van Updated",
    });

    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: /Sửa Parent/i }));
    fireEvent.change(screen.getByLabelText("Tên hiển thị"), {
      target: { value: "Nguyen Van Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(PARENT_ID, {
        display_name: "Nguyen Van Updated",
      });
    });
    expect(await screen.findByText("Đã cập nhật hồ sơ Parent.")).toBeInTheDocument();
  });

});
