import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminParentsScreen } from "@/components/admin/admin-parents-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";

const { list } = vi.hoisted(() => ({
  list: vi.fn(),
}));

function renderScreen() {
  const services = {
    parents: { list },
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
});
