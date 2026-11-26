import fs from "node:fs";
import path from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountSettingsScreen } from "@/components/settings/account-settings-screen";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import { AuthServiceError } from "@/lib/api/auth-service";
import type { ParentProfileDTO } from "@/types/profile";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const baseProfile: ParentProfileDTO = {
  id: "10000000-0000-4000-8000-000000000001",
  display_name: "BaMẹTênRấtDàiKhôngCóKhoảngTrắngĐểKiểmTraTrànMànHình",
  role: "parent",
  created_at: "2026-10-01T00:00:00Z",
  email: "verylongparentemailaddresswithoutspaces@example.com",
  contact_phone: null,
  pending_email: "pendingveryverylongemail@example.com",
  email_verified: true,
  contact_info_status: "available",
  children: [],
};

beforeEach(() => {
  installApiFetchFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountSettingsScreen", () => {
  it("shows loading, error retry with responsive width, and ready dl grid with min-w-0", async () => {
    const authService = createAuthServiceFixture();
    authService.getCurrentUser.mockResolvedValueOnce({
      ...authSessionFixture.user,
      providers: ["email"],
    });
    apiFetchFixture
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(Response.json(baseProfile));

    const user = userEvent.setup();
    render(withAuthFixture(<AccountSettingsScreen />, authService));

    const retryBtn = await screen.findByRole("button", { name: "Thử tải lại" });
    expect(retryBtn).toHaveClass("w-full", "min-[640px]:w-auto");

    authService.getCurrentUser.mockResolvedValueOnce({
      ...authSessionFixture.user,
      providers: ["email"],
    });
    await user.click(retryBtn);

    expect(
      await screen.findByRole("heading", { name: "Thông tin tài khoản" }),
    ).toBeInTheDocument();

    const dl = screen.getByText("Tên hiển thị").closest("dl");
    expect(dl).toHaveClass("min-[640px]:grid-cols-2");
    const gridCells = dl ? Array.from(dl.children) : [];
    expect(gridCells).toHaveLength(4);
    for (const cell of gridCells) {
      expect(cell).toHaveClass("min-w-0");
    }

    expect(screen.getByText(baseProfile.pending_email!)).toHaveClass(
      "break-all",
    );
  });

  it("validates password fields, toggles visibility with size-11 buttons, and submits password change", async () => {
    const authService = createAuthServiceFixture();
    authService.getCurrentUser.mockResolvedValue({
      ...authSessionFixture.user,
      providers: ["email"],
    });
    apiFetchFixture.mockResolvedValueOnce(Response.json(baseProfile));

    const user = userEvent.setup();
    render(withAuthFixture(<AccountSettingsScreen />, authService));

    await user.click(
      await screen.findByRole("button", { name: "Đổi mật khẩu" }),
    );

    const submitBtn = screen.getByRole("button", { name: "Lưu mật khẩu mới" });
    expect(submitBtn).toHaveClass("w-full", "min-[640px]:w-auto");

    await user.click(submitBtn);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "nhập mật khẩu hiện tại",
    );

    const toggleCurrent = screen.getByRole("button", {
      name: "Hiện mật khẩu hiện tại",
    });
    expect(toggleCurrent).toHaveClass("size-11");
    await user.click(toggleCurrent);
    expect(
      screen.getByRole("button", { name: "Ẩn mật khẩu hiện tại" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Mật khẩu hiện tại"), "oldpass123");
    await user.type(screen.getByLabelText("Mật khẩu mới"), "short");
    await user.type(screen.getByLabelText("Xác nhận mật khẩu mới"), "short");
    await user.click(submitBtn);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ít nhất 8 ký tự",
    );

    await user.clear(screen.getByLabelText("Mật khẩu mới"));
    await user.clear(screen.getByLabelText("Xác nhận mật khẩu mới"));
    await user.type(screen.getByLabelText("Mật khẩu mới"), "newpassword1");
    await user.type(
      screen.getByLabelText("Xác nhận mật khẩu mới"),
      "different1",
    );
    await user.click(submitBtn);
    expect(await screen.findByRole("alert")).toHaveTextContent("chưa khớp");

    await user.clear(screen.getByLabelText("Xác nhận mật khẩu mới"));
    await user.type(
      screen.getByLabelText("Xác nhận mật khẩu mới"),
      "newpassword1",
    );
    await user.click(submitBtn);

    await waitFor(() => {
      expect(authService.changePassword).toHaveBeenCalledWith({
        currentPassword: "oldpass123",
        newPassword: "newpassword1",
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Mật khẩu đã được cập nhật",
    );
    expect(screen.getByLabelText("Mật khẩu hiện tại")).toHaveValue("");
  });

  it("surfaces invalid-credentials errors on password change and supports OAuth password setup request", async () => {
    const authService = createAuthServiceFixture();
    authService.getCurrentUser.mockResolvedValue({
      ...authSessionFixture.user,
      providers: ["email"],
    });
    authService.changePassword.mockRejectedValueOnce(
      new AuthServiceError("invalid-credentials", "Wrong current password"),
    );
    apiFetchFixture.mockResolvedValueOnce(Response.json(baseProfile));

    const user = userEvent.setup();
    const { unmount } = render(
      withAuthFixture(<AccountSettingsScreen />, authService),
    );

    await user.click(
      await screen.findByRole("button", { name: "Đổi mật khẩu" }),
    );
    await user.type(screen.getByLabelText("Mật khẩu hiện tại"), "wrongpass");
    await user.type(screen.getByLabelText("Mật khẩu mới"), "newpassword1");
    await user.type(
      screen.getByLabelText("Xác nhận mật khẩu mới"),
      "newpassword1",
    );
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Mật khẩu hiện tại chưa chính xác.",
    );
    unmount();

    const oauthAuthService = createAuthServiceFixture();
    oauthAuthService.getCurrentUser.mockResolvedValue({
      ...authSessionFixture.user,
      providers: ["google"],
    });
    apiFetchFixture.mockResolvedValueOnce(Response.json(baseProfile));

    render(withAuthFixture(<AccountSettingsScreen />, oauthAuthService));

    await user.click(
      await screen.findByRole("button", { name: "Đổi mật khẩu" }),
    );
    const resetBtn = screen.getByRole("button", {
      name: /Chưa có mật khẩu\? Gửi liên kết đặt mật khẩu qua email/,
    });
    expect(resetBtn).toHaveClass("h-auto", "w-full", "min-[640px]:w-auto");

    await user.click(resetBtn);
    await waitFor(() => {
      expect(oauthAuthService.requestPasswordReset).toHaveBeenCalledWith({
        email: baseProfile.email,
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Supabase Auth đã tiếp nhận",
    );
  });

  it("contains zero legacy sm:, max-sm:, max-[639px]:, or max-[767px]: classes in settings component", () => {
    const content = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "components/settings/account-settings-screen.tsx",
      ),
      "utf8",
    );
    expect(content).not.toMatch(
      /(?<![\w-])(sm:|max-sm:|max-\[639px\]:|max-\[767px\]:)/,
    );
  });
});
