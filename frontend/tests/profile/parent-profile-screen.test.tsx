import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParentProfileScreen } from "@/components/profile/parent-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import type { ParentProfileDTO } from "@/types/profile";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: authMocks,
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

beforeEach(() => {
  installApiFetchFixture();
  authMocks.getSession.mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
  authMocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: "10000000-0000-4000-8000-000000000001",
        email: "parent@example.com",
        phone: "+84900000000",
      },
    },
    error: null,
  });
  authMocks.updateUser.mockResolvedValue({ data: { user: null }, error: null });
  authMocks.verifyOtp.mockResolvedValue({
    data: { user: null, session: null },
    error: null,
  });
  authMocks.resend.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => vi.unstubAllGlobals());

const profile: ParentProfileDTO = {
  id: "10000000-0000-4000-8000-000000000001",
  display_name: "Ba mẹ kiểm thử",
  role: "parent",
  created_at: "2026-10-01T00:00:00Z",
  email: "parent@example.com",
  contact_phone: "+84900000000",
  pending_email: null,
  email_verified: true,
  contact_info_status: "available",
  children: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      alias: "Bé An",
      grade: 2,
      created_at: "2026-10-02T00:00:00Z",
    },
  ],
};

function renderProfile() {
  return render(
    <AppServicesProvider>
      <ParentProfileScreen />
    </AppServicesProvider>,
  );
}

describe("ParentProfileScreen inline editing", () => {
  it("renders profile and children without account ID or phone verification UI", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(profile));
    renderProfile();

    expect(
      await screen.findByRole("heading", { name: profile.display_name ?? "" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Phụ huynh")).toHaveLength(2);
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(screen.getByText("+84900000000")).toBeInTheDocument();
    expect(screen.queryByText(profile.id)).not.toBeInTheDocument();
    expect(screen.queryByText(/mã tài khoản/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sao chép mã tài khoản/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Đã xác minh")).toBeInTheDocument();
    expect(screen.queryByText("Chưa xác minh")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Bé An" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Lớp 2")).toBeInTheDocument();
    expect(screen.queryByText(/settings/i)).not.toBeInTheDocument();
    expect(requestedApiUrl().pathname).toBe("/profiles/me");
  });

  it("edits the email in place and leaves verification pending until Auth confirms it", async () => {
    apiFetchFixture
      .mockResolvedValueOnce(Response.json(profile))
      .mockResolvedValueOnce(
        Response.json({
          ...profile,
          pending_email: "new-parent@example.com",
        }),
      );

    const user = userEvent.setup();
    renderProfile();

    await user.click(
      await screen.findByRole("button", { name: "Chỉnh sửa email" }),
    );

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("Số điện thoại liên hệ")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "new-parent@example.com");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("Đã gửi yêu cầu đổi email");
    expect(authMocks.updateUser).toHaveBeenCalledWith(
      { email: "new-parent@example.com" },
      {
        emailRedirectTo: expect.stringContaining(
          "/auth/callback?next=%2Fprofile",
        ),
      },
    );
    expect(screen.getByText("Đang chờ xác minh email mới:")).toBeInTheDocument();
    expect(screen.getByText("new-parent@example.com")).toBeInTheDocument();
    expect(authMocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("edits contact phone in place by saving to the Profile API without Auth OTP or SMS", async () => {
    apiFetchFixture
      .mockResolvedValueOnce(Response.json(profile))
      .mockResolvedValueOnce(
        Response.json({
          ...profile,
          contact_phone: "+84912345678",
        }),
      );

    const user = userEvent.setup();
    renderProfile();

    await user.click(
      await screen.findByRole("button", {
        name: "Chỉnh sửa số điện thoại liên hệ",
      }),
    );

    expect(
      screen.getByLabelText("Số điện thoại liên hệ"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Mã OTP gồm 6 chữ số")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Số điện thoại liên hệ"));
    await user.type(
      screen.getByLabelText("Số điện thoại liên hệ"),
      "0912345678",
    );
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("Đã lưu số điện thoại liên hệ. Không cần xác minh.");
    expect(screen.getByText("+84912345678")).toBeInTheDocument();

    const mutation = apiFetchFixture.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(mutation?.[0]).toBe(
      "http://127.0.0.1:8000/profiles/me/contact-phone",
    );
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({
      contact_phone: "+84912345678",
    });
    expect(authMocks.updateUser).not.toHaveBeenCalled();
    expect(authMocks.verifyOtp).not.toHaveBeenCalled();
    expect(authMocks.resend).not.toHaveBeenCalled();
  });

  it("edits display name inline and persists through the existing profile API", async () => {
    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/profiles/me")) {
        return Response.json(profile);
      }
      if (init?.method === "PUT") {
        return Response.json({
          Id: profile.id,
          Role: profile.role,
          DisplayName: "Ba Mẹ Mây",
          CreatedAt: profile.created_at,
        });
      }
      return Response.json(profile);
    });

    const user = userEvent.setup();
    renderProfile();

    await user.click(
      await screen.findByRole("button", { name: "Chỉnh sửa tên hiển thị" }),
    );
    const field = screen.getByLabelText("Tên hiển thị của ba mẹ");
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập tên hiển thị."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Tên hiển thị của ba mẹ"), "Ba Mẹ Mây");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(
      await screen.findByRole("heading", { name: "Ba Mẹ Mây" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("Đã cập nhật tên hiển thị.");
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it("keeps load errors generic", async () => {
    apiFetchFixture.mockRejectedValueOnce(
      new Error("Private profile details"),
    );
    renderProfile();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private profile details");
  });

  it("exposes an accessible loading state for a pending response", async () => {
    let settle: (response: Response) => void = () => undefined;
    apiFetchFixture.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );

    renderProfile();
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
    await waitFor(() => expect(apiFetchFixture).toHaveBeenCalledOnce());

    await act(async () => {
      settle(Response.json(profile));
    });

    expect(
      await screen.findByRole("heading", { name: profile.display_name ?? "" }),
    ).toBeInTheDocument();
  });
});
