import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    expect(
      screen.getByText(/ID: 22222222-2222-4222-8222-222222222222/),
    ).toBeInTheDocument();
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
    expect(
      screen.queryByText("internal server detail"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  it(
      "creates a Parent through the API service instead of local mock data",
      async () => {
      list.mockResolvedValue({
        items: [],
        total: 0,
        limit: 10,
        offset: 0,
      });
      create.mockResolvedValue({});

      renderScreen();

      fireEvent.click(
        await screen.findByRole("button", { name: /Thêm Parent/i }),
      );
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
    },
  );

  it(
      "opens the edit dialog while loading and saves the selected parent's data once",
      async () => {
      const parent = {
        id: "22222222-2222-4222-8222-222222222222",
        display_name: "Nguyen Van A",
        created_at: "2026-10-01T00:00:00Z",
        children_count: 1,
      };
      const detail = {
        id: parent.id,
        display_name: parent.display_name,
        email: "parent@example.com",
        phone: "0900000000",
        created_at: parent.created_at,
        children: [],
        contact_info_status: "available",
      } as const;
      let resolveDetail!: (value: typeof detail) => void;
      list.mockResolvedValue({ items: [parent], total: 1, limit: 10, offset: 0 });
      getById.mockImplementationOnce(
        () =>
          new Promise<typeof detail>((resolve) => {
            resolveDetail = resolve;
          }),
      );
      update.mockResolvedValue({});

      renderScreen();
      await screen.findByRole("heading", { name: "Nguyen Van A" });
      fireEvent.click(screen.getByRole("button", { name: /Sửa/i }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByText("Đang tải thông tin tài khoản…"),
      ).toBeInTheDocument();
      expect(getById).toHaveBeenCalledWith(parent.id);

      await act(async () => {
        resolveDetail(detail);
      });
      expect(
        await screen.findByDisplayValue("parent@example.com"),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Tên hiển thị"), {
        target: { value: "Nguyen Van Updated" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

      await waitFor(() => {
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(parent.id, {
          display_name: "Nguyen Van Updated",
        });
      });
      expect(
        await screen.findByText("Đã cập nhật hồ sơ Parent."),
      ).toBeInTheDocument();
    },
  );

  it(
      "updates email and phone through one locked contact-information request",
      async () => {
      const parent = {
        id: "22222222-2222-4222-8222-222222222222",
        display_name: "Nguyen Van A",
        created_at: "2026-10-01T00:00:00Z",
        children_count: 0,
      };
      const detail = {
        id: parent.id,
        display_name: parent.display_name,
        email: "parent@example.com",
        phone: "0900000000",
        created_at: parent.created_at,
        children: [],
        contact_info_status: "available",
      } as const;
      let completeUpdate!: () => void;
      list.mockResolvedValue({ items: [parent], total: 1, limit: 10, offset: 0 });
      getById.mockResolvedValueOnce(detail);
      update.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeUpdate = () => resolve({});
          }),
      );

      renderScreen();
      await screen.findByRole("heading", { name: "Nguyen Van A" });
      fireEvent.click(screen.getByRole("button", { name: /Sửa/i }));
      const email = await screen.findByDisplayValue("parent@example.com");
      const phone = screen.getByDisplayValue("0900000000");
      fireEvent.change(email, { target: { value: "New.Parent@Example.com" } });
      fireEvent.change(phone, { target: { value: "0911111111" } });

      const saveButton = screen.getByRole("button", { name: "Lưu thay đổi" });
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);

      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith(parent.id, {
        email: "new.parent@example.com",
        phone: "0911111111",
      });

      await act(async () => {
        completeUpdate();
      });
      expect(
        await screen.findByText("Đã cập nhật hồ sơ Parent."),
      ).toBeInTheDocument();
    },
  );

  it("does not send an update when a contact field is cleared", async () => {
    const parent = {
      id: "22222222-2222-4222-8222-222222222222",
      display_name: "Nguyen Van A",
      created_at: "2026-10-01T00:00:00Z",
      children_count: 0,
    };
    list.mockResolvedValue({ items: [parent], total: 1, limit: 10, offset: 0 });
    getById.mockResolvedValue({
      id: parent.id,
      display_name: parent.display_name,
      email: "parent@example.com",
      phone: "0900000000",
      created_at: parent.created_at,
      children: [],
      contact_info_status: "available",
    });

    renderScreen();
    await screen.findByRole("heading", { name: "Nguyen Van A" });
    fireEvent.click(screen.getByRole("button", { name: /Sửa/i }));
    const email = await screen.findByDisplayValue("parent@example.com");
    fireEvent.change(email, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(
      await screen.findByText(/Backend hiện không hỗ trợ xóa email/i),
    ).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
  it(
      "soft-deletes a Parent through the API and removes it from the refreshed list",
      async () => {
      const parent = {
        id: "22222222-2222-4222-8222-222222222222",
        display_name: "Nguyen Van A",
        created_at: "2026-10-01T00:00:00Z",
        children_count: 2,
      };
      list
        .mockResolvedValueOnce({
          items: [parent],
          total: 1,
          limit: 10,
          offset: 0,
        })
        .mockResolvedValue({
          items: [],
          total: 0,
          limit: 10,
          offset: 0,
        });
      deactivate.mockResolvedValueOnce({ id: parent.id, active: 0 });

      renderScreen();
      expect(
        await screen.findByRole("heading", { name: "Nguyen Van A" }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Vô hiệu hóa" }));
      expect(
        await screen.findByText(/Đây là xóa mềm/i),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Vô hiệu hóa Parent" }));

      await waitFor(() => {
        expect(deactivate).toHaveBeenCalledWith(parent.id);
      });
      expect(
        await screen.findByText("Chưa có hồ sơ phụ huynh"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Nguyen Van A" }),
      ).not.toBeInTheDocument();
    },
  );
});
