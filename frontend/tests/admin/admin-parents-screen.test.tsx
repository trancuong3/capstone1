import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminParentsScreen } from "@/components/admin/admin-parents-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";

const { list, create, getById, update, hide, restore } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  hide: vi.fn(),
  restore: vi.fn(),
}));

function renderScreen() {
  const services = {
    parents: { list, create, getById, update, hide, restore },
  } as unknown as AdminServices;

  return render(
    <AdminServicesContext.Provider value={services}>
      <AdminParentsScreen />
    </AdminServicesContext.Provider>,
  );
}

describe("AdminParentsScreen", () => {
  beforeEach(() => {
    list.mockReset();
    create.mockReset();
    getById.mockReset();
    update.mockReset();
    hide.mockReset();
    restore.mockReset();
  });

  it("renders parent profiles returned by the database service", async () => {
    list.mockResolvedValueOnce({
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          display_name: "Nguyen Van A",
          created_at: "2026-10-01T00:00:00Z",
          children_count: 2,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });

    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Nguyen Van A" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/ID: 22222222-2222-4222-8222-222222222222/))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Xem chi tiết/i })).toHaveAttribute(
      "href",
      "/admin/parents/22222222-2222-4222-8222-222222222222",
    );
    expect(list).toHaveBeenCalledWith({
      search: undefined,
      limit: 10,
      offset: 0,
    });
  });

  it("shows a safe error and allows retry when loading fails", async () => {
    list.mockRejectedValueOnce(new Error("internal server detail"));
    list.mockResolvedValueOnce({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
    });

    renderScreen();

    expect(
      await screen.findByText("Không thể tải danh sách phụ huynh"),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal server detail")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  it("creates a Parent through the API service instead of local mock data", async () => {
    list.mockResolvedValue({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
    });
    create.mockResolvedValue({});

    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: /Thêm Parent/i }));
    fireEvent.change(screen.getByLabelText("Tên hiển thị"), {
      target: { value: "Nguyen Van B" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "parent-b@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Số điện thoại"), {
      target: { value: "0900000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạo Parent" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        display_name: "Nguyen Van B",
        email: "parent-b@example.com",
        phone: "0900000000",
      });
    });
    expect(
      await screen.findByText(/Đã gửi lời mời tạo tài khoản Parent/i),
    ).toBeInTheDocument();
  });

  it("confirms Hide and refreshes the visible directory only after the API succeeds", async () => {
    const parentId = "22222222-2222-4222-8222-222222222222";
    list
      .mockResolvedValueOnce({
        items: [{
          id: parentId,
          display_name: "Nguyen Van A",
          created_at: "2026-10-01T00:00:00Z",
          children_count: 2,
          admin_hidden_at: null,
        }],
        total: 1,
        limit: 10,
        offset: 0,
      })
      .mockResolvedValueOnce({ items: [], total: 0, limit: 10, offset: 0 });
    hide.mockResolvedValue({ id: parentId, is_hidden: true, admin_hidden_at: "2026-10-12T00:00:00Z" });

    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: /^Ẩn$/i }));
    expect(
      await screen.findByText(/Dữ liệu Parent, Child và lịch sử vẫn được giữ nguyên/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận ẩn" }));

    await waitFor(() => expect(hide).toHaveBeenCalledWith(parentId));
    expect(
      await screen.findByText(/Đã ẩn hồ sơ khỏi danh sách quản lý/i),
    ).toBeInTheDocument();
  });

  it("restores a hidden Parent and reloads the hidden directory from the API", async () => {
    const parentId = "44444444-4444-4444-8444-444444444444";
    list
      .mockResolvedValueOnce({
        items: [{
          id: parentId,
          display_name: "Hidden Parent",
          created_at: "2026-10-01T00:00:00Z",
          children_count: 1,
          admin_hidden_at: "2026-10-11T00:00:00Z",
        }],
        total: 1,
        limit: 10,
        offset: 0,
      })
      .mockResolvedValueOnce({ items: [], total: 0, limit: 10, offset: 0 });
    restore.mockResolvedValue({ id: parentId, is_hidden: false, admin_hidden_at: null });

    renderScreen();

    // Switch to the hidden list before checking Restore.
    fireEvent.click(await screen.findByRole("button", { name: "Đã ẩn" }));
    expect(await screen.findByText("Hidden Parent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Khôi phục hiển thị" }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith(parentId));
    expect(
      await screen.findByText("Đã khôi phục hiển thị Parent."),
    ).toBeInTheDocument();
  });

});
