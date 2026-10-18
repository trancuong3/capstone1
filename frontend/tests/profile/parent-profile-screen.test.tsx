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
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

const profile: ParentProfileDTO = {
  id: "10000000-0000-4000-8000-000000000001",
  display_name: "Ba mẹ kiểm thử",
  role: "parent",
  created_at: "2026-10-01T00:00:00Z",
  email: "parent@example.com",
  phone: "0900000000",
  email_verified: true,
  phone_verified: false,
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
describe("ParentProfileScreen with real API adapter", () => {
  it("renders contact details, account ID, and only the linked child summary", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(profile));
    renderProfile();
    expect(
      await screen.findByRole("heading", { name: profile.display_name ?? "" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Phụ huynh")).toHaveLength(2);
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(screen.getByText("0900000000")).toBeInTheDocument();
    expect(screen.getByText(profile.id)).toBeInTheDocument();
    expect(screen.getByText("Đã xác minh")).toBeInTheDocument();
    expect(screen.getByText("Chưa xác minh")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bé An" })).toBeInTheDocument();
    expect(screen.getByText("Lớp 2")).toBeInTheDocument();
    expect(screen.queryByText(/settings/i)).not.toBeInTheDocument();
    expect(requestedApiUrl().pathname).toBe("/profiles/me");
  });
  it("validates and updates the permitted display name using the current backend contract", async () => {
    apiFetchFixture.mockImplementation(async (_input, init) =>
      Response.json(
        init?.method === "PUT"
          ? { ...profile, display_name: "Ba Mẹ Mây" }
          : profile,
      ),
    );
    const user = userEvent.setup();
    renderProfile();
    await user.click(
      await screen.findByRole("button", { name: "Chỉnh sửa hồ sơ" }),
    );
    const field = screen.getByLabelText("Tên hiển thị của ba mẹ");
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
    expect(
      await screen.findByText("Ba mẹ vui lòng nhập tên hiển thị."),
    ).toBeInTheDocument();
    expect(apiFetchFixture).toHaveBeenCalledTimes(1);
    await user.type(field, "Ba Mẹ Mây");
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Đã cập nhật hồ sơ",
    );
    expect(
      screen.getByRole("heading", { name: "Ba Mẹ Mây" }),
    ).toBeInTheDocument();
    const mutation = apiFetchFixture.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(mutation?.[0]).toBe(`http://127.0.0.1:8000/profiles/${profile.id}`);
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({
      Role: "parent",
      displayname: "Ba Mẹ Mây",
    });
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
