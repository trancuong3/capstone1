import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminParentsScreen } from "@/components/admin/admin-parents-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";

const { list, create, getById, update, deactivate } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  deactivate: vi.fn(),
}));

function renderScreen() {
  const services = {
    parents: { list, create, getById, update, deactivate },
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
    deactivate.mockReset();
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

  it("soft-deletes a Parent through the API and removes it from the refreshed list", async () => {
    const parent = {
      id: "22222222-2222-4222-8222-222222222222",
      display_name: "Nguyen Van A",
      created_at: "2026-10-01T00:00:00Z",
      children_count: 2,
    };
    list.mockResolvedValueOnce({
      items: [parent],
      total: 1,
      limit: 10,
      offset: 0,
    }).mockResolvedValue({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
    });
    deactivate.mockResolvedValueOnce({ id: parent.id, active: 0 });

    renderScreen();
    expect(await screen.findByRole("heading", { name: "Nguyen Van A" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
    expect(await screen.findByText(/Đây là xóa mềm/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Xóa Parent" }));

    await waitFor(() => {
      expect(deactivate).toHaveBeenCalledWith(parent.id);
    });
    expect(await screen.findByText("Chưa có hồ sơ phụ huynh")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Nguyen Van A" })).not.toBeInTheDocument();
  });
});
