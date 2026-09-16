import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import type { AppMockScenario } from "@/types/ui-state";

const currentChildId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catBookId = "20000000-0000-4000-8000-000000000001";
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function renderDetail(bookScenario: AppMockScenario = "default") {
  return render(
    <AppStoreProvider>
      <AppServicesProvider bookScenario={bookScenario} scenario="default">
        <BookDetailScreen
          bookId={catBookId}
          requestedChildId={currentChildId}
        />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}

describe("BookDetailScreen", () => {
  beforeEach(() => pushMock.mockReset());

  it("selects a verified preview page and creates a typed mock session", async () => {
    const user = userEvent.setup();
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Chú Mèo Nhỏ" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Chọn trang 4" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Chọn trang 5" }));
    await user.click(screen.getByRole("button", { name: /Bắt đầu đọc/ }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        "/reading/mock-session-001?state=ready&pageId=30000000-0000-4000-8000-000000000015",
      ),
    );
  });

  it("shows canonical not-found and unavailable states", async () => {
    const { rerender } = renderDetail("not-found");

    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy sách" }),
    ).toBeInTheDocument();

    rerender(
      <AppStoreProvider>
        <AppServicesProvider bookScenario="unavailable" scenario="default">
          <BookDetailScreen
            bookId={catBookId}
            requestedChildId={currentChildId}
          />
        </AppServicesProvider>
      </AppStoreProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Sách hiện chưa sẵn sàng" }),
    ).toBeInTheDocument();
  });

  it("keeps detail failures generic and retryable", async () => {
    renderDetail("error");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });
});
