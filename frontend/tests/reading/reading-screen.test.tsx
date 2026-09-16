import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingUiState } from "@/types/reading";

const sessionId = "mock-session-001";

function renderReading(
  state: ReadingUiState,
  reconnect = "recover" as const,
  requestedSessionId = sessionId,
) {
  return render(
    <AppStoreProvider>
      <AppServicesProvider scenario="default">
        <ReadingScreen
          initialUiState={state}
          reconnectMode={reconnect}
          sessionId={requestedSessionId}
        />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}

describe("ReadingScreen", () => {
  it("switches from ready to the listening reading UI", async () => {
    const user = userEvent.setup();
    renderReading("ready");

    expect(
      await screen.findAllByRole("heading", { name: "Sẵn sàng đọc chưa nào?" }),
    ).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));

    expect(
      await screen.findByRole("navigation", { name: "Điều khiển buổi đọc" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Mình đang nghe bé đọc")).toBeInTheDocument();
    expect(
      screen.getByText(/Trạng thái kết nối: đã kết nối\./),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Trạng thái kết nối: đang kết nối lại\./),
    ).not.toBeInTheDocument();
  });

  it("keeps paused and reconnecting intervals free of child errors", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderReading("paused");

    expect(
      await screen.findByRole("dialog", { name: "Bé đang nghỉ một chút" }),
    ).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute(
      "data-child-error-count",
      "0",
    );
    expect(container.firstElementChild).toHaveAttribute(
      "data-scoring-active",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Đọc tiếp" }));
    expect(
      await screen.findByText("Mình đang nghe bé đọc"),
    ).toBeInTheDocument();

    unmount();
    renderReading("reconnecting");
    expect(
      await screen.findByRole("dialog", { name: "Đợi mình một chút nhé…" }),
    ).toHaveTextContent("không tạo lỗi đọc");
  });

  it("shows permission recovery without blaming the child", async () => {
    const user = userEvent.setup();
    renderReading("camera-denied");

    expect(
      await screen.findByRole("dialog", { name: "Camera chưa sẵn sàng" }),
    ).toHaveTextContent("camera chưa được mở");
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(
      await screen.findByText("Mình đang nghe bé đọc"),
    ).toBeInTheDocument();
  });

  it("offers a working safe exit instead of a no-op microphone action", async () => {
    const user = userEvent.setup();
    renderReading("microphone-denied");

    expect(
      await screen.findByRole("dialog", {
        name: "Mình chưa nghe thấy giọng bé",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kết thúc an toàn" }));
    expect(
      screen.getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" }),
    ).toBeInTheDocument();
  });

  it("selects only an eligible same-book page manually", async () => {
    const user = userEvent.setup();
    renderReading("manual-page");

    expect(
      await screen.findByRole("dialog", { name: "Bé đang đọc trang nào?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chọn trang 5" }));
    await user.click(screen.getByRole("button", { name: "Đúng trang này" }));

    expect(await screen.findByLabelText("Trang sách 5")).toHaveAttribute(
      "data-page-revision-id",
      "40000000-0000-4000-8000-000000000015",
    );
  });

  it("rebinds the highlighted word when the page turns", async () => {
    renderReading("page-turn");

    const pageFive = await screen.findByLabelText("Trang sách 5");
    await waitFor(() => {
      expect(pageFive).toHaveAttribute(
        "data-page-revision-id",
        "40000000-0000-4000-8000-000000000015",
      );
    });
    expect(
      pageFive.querySelector('[data-word-id$="000000000503"]'),
    ).toBeTruthy();
  });

  it("keeps expected-answer data out of the question UI", async () => {
    const user = userEvent.setup();
    renderReading("question");

    expect(
      await screen.findByRole("heading", { name: "Mình cùng trả lời nhé!" }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("expected_answer");
    await user.click(await screen.findByRole("button", { name: /Trên bàn/ }));
    expect(
      await screen.findByText("Gần đúng rồi, thử lại nhé."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Bên cửa sổ/ }));
    expect(
      await screen.findByText("Đúng rồi! Bé nhớ rất tốt."),
    ).toBeInTheDocument();
  });

  it("renders the same safe not-found state for an unknown session", async () => {
    renderReading("ready", "recover", "ffffffff-ffff-4fff-8fff-ffffffffffff");

    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy buổi đọc" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/không tồn tại hoặc không thuộc tài khoản hiện tại/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/mock-reading-session-not-found/i)).toBeNull();
  });
});
