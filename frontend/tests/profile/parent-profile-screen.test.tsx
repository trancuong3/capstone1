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

const authServiceMock = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
}));
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

vi.mock("@/hooks/use-auth-service", () => ({
  useAuthService: () => authServiceMock,
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
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:parent-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
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
  authServiceMock.getCurrentUser.mockResolvedValue({
    display_name: "Tên từ OAuth",
    email: "parent@example.com",
    id: profile.id,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

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

describe("ParentProfileScreen", () => {
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
    expect(screen.getByRole("heading", { name: "Bé An" })).toBeInTheDocument();
    expect(screen.getByText("Lớp 2")).toBeInTheDocument();
    expect(screen.queryByText(/settings/i)).not.toBeInTheDocument();
    expect(requestedApiUrl().pathname).toBe("/profiles/me");
  });

  it("opens one form for the complete profile, including avatar and all contact fields", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(profile));
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole("button", { name: "Chỉnh sửa" }));

    expect(screen.getByLabelText("Họ và tên")).toHaveValue(
      profile.display_name,
    );
    expect(screen.getByLabelText("Email")).toHaveValue(profile.email);
    expect(screen.getByLabelText("Số điện thoại liên hệ")).toHaveValue(
      profile.contact_phone,
    );
    expect(
      screen.getByLabelText("Chọn ảnh đại diện PNG, JPG hoặc WEBP"),
    ).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(
      screen.getByRole("button", { name: "Lưu thay đổi" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hủy" })).toBeInTheDocument();
  });

  it("discards all unsaved values when the parent cancels", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(profile));
    const user = userEvent.setup();
    renderProfile();

    await user.click(await screen.findByRole("button", { name: "Chỉnh sửa" }));
    await user.clear(screen.getByLabelText("Họ và tên"));
    await user.type(screen.getByLabelText("Họ và tên"), "Tên chưa lưu");
    await user.click(screen.getByRole("button", { name: "Hủy" }));

    expect(
      screen.getByRole("heading", { name: profile.display_name ?? "" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Họ và tên")).not.toBeInTheDocument();
  });

  it("edits the email in the unified form and leaves verification pending until Auth confirms it", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Chỉnh sửa" }));

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Số điện thoại liên hệ")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "new-parent@example.com");
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Email mới chỉ có hiệu lực sau khi ba mẹ xác minh",
    );
    expect(authMocks.updateUser).toHaveBeenCalledWith(
      { email: "new-parent@example.com" },
      {
        emailRedirectTo: expect.stringContaining(
          "/auth/callback?next=%2Fprofile",
        ),
      },
    );
    expect(
      screen.getByText("Đang chờ xác minh email mới:"),
    ).toBeInTheDocument();
    expect(screen.getByText("new-parent@example.com")).toBeInTheDocument();
    expect(authMocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("edits contact phone in the unified form through the Profile API without Auth OTP or SMS", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Chỉnh sửa" }));

    expect(screen.getByLabelText("Số điện thoại liên hệ")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Mã OTP gồm 6 chữ số"),
    ).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Số điện thoại liên hệ"));
    await user.type(
      screen.getByLabelText("Số điện thoại liên hệ"),
      "0912345678",
    );
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Đã lưu các thay đổi hồ sơ.",
    );
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

  it("edits display name in the unified form through the existing profile API", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Chỉnh sửa" }));
    const field = screen.getByLabelText("Họ và tên");
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập tên hiển thị."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Họ và tên"), "Ba Mẹ Mây");
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(
      await screen.findByRole("heading", { name: "Ba Mẹ Mây" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Đã lưu các thay đổi hồ sơ.",
    );
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it("keeps the persisted avatar when an upload fails", async () => {
    const existingAvatar = "https://storage.example/parent-current.webp";
    apiFetchFixture
      .mockResolvedValueOnce(
        Response.json({ ...profile, avatar_url: existingAvatar }),
      )
      .mockResolvedValueOnce(
        Response.json({ detail: "safe storage failure" }, { status: 503 }),
      );

    const user = userEvent.setup();
    renderProfile();
    await user.click(await screen.findByRole("button", { name: "Chỉnh sửa" }));
    await user.upload(
      screen.getByLabelText("Chọn ảnh đại diện PNG, JPG hoặc WEBP"),
      new File(["new-avatar"], "avatar.png", { type: "image/png" }),
    );

    expect(
      screen
        .getByRole("img", { name: "Ảnh xem trước của Ba mẹ kiểm thử" })
        .querySelector("img"),
    ).toHaveAttribute("src", "blob:parent-preview");
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "safe storage failure",
    );

    await user.click(screen.getByRole("button", { name: "Hủy" }));
    expect(
      screen
        .getByRole("img", { name: "Ảnh đại diện của Ba mẹ kiểm thử" })
        .querySelector("img"),
    ).toHaveAttribute("src", existingAvatar);
  });

  it("keeps load errors generic", async () => {
    apiFetchFixture.mockRejectedValueOnce(new Error("Private profile details"));
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
