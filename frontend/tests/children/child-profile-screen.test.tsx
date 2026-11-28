import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { ChildProfileScreen } from "@/components/children/child-profile-screen";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

const { routerPushMock, routerReplaceMock } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
    prefetch: vi.fn(),
  }),
}));

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

function installMobileMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => true,
    })),
  );
}

beforeEach(() => {
  routerPushMock.mockReset();
  routerReplaceMock.mockReset();
  installApiFetchFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChildProfileScreen", () => {
  it("creates a child during onboarding and redirects to book selection", async () => {
    const user = userEvent.setup();
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        ...childFixture,
        id: "22000000-0000-4000-8000-000000000009",
        alias: "Bé Sóc",
        grade: 1,
      }),
    );

    render(
      <AppServicesProvider>
        <ChildProfileScreen fromRegistration mode="create" />
      </AppServicesProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Tài khoản đã sẵn sàng" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Quay lại" }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Tên gọi của bé"), "Bé Sóc");
    await user.selectOptions(screen.getByLabelText("Lớp của bé"), "1");
    await user.click(screen.getByRole("button", { name: "Lưu và chọn sách" }));

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(
        "/books?childId=22000000-0000-4000-8000-000000000009",
      );
    });
  });

  it("loads edit mode, updates profile, and deletes via bottom-sheet footer modal", async () => {
    const user = userEvent.setup();
    apiFetchFixture
      .mockResolvedValueOnce(Response.json(childFixture))
      .mockResolvedValueOnce(
        Response.json({ ...childFixture, alias: "Bé An Mới", grade: 3 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(
      <AppServicesProvider>
        <ChildProfileScreen childId={TEST_CHILD_ID} mode="edit" />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: `Hồ sơ của ${childFixture.alias}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: `Chọn sách cho ${childFixture.alias}` }),
    ).toHaveAttribute("href", `/books?childId=${TEST_CHILD_ID}`);

    const aliasInput = screen.getByLabelText("Tên gọi của bé");
    await user.clear(aliasInput);
    await user.type(aliasInput, "Bé An Mới");
    await user.selectOptions(screen.getByLabelText("Lớp của bé"), "3");
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thay đổi của hồ sơ bé đã được lưu.",
    );
    expect(
      screen.getByRole("heading", { name: "Hồ sơ của Bé An Mới" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Xóa hồ sơ bé" }));
    const dialog = screen.getByRole("alertdialog", { name: "Xóa hồ sơ bé?" });
    expect(dialog.querySelector('[data-modal-footer="true"]')).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Xóa hồ sơ" }));

    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/children");
    });
  });

  it("shows not-found state on 404 without leaking data", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ detail: "Not found" }, { status: 404 }),
    );

    render(
      <AppServicesProvider>
        <ChildProfileScreen childId={TEST_CHILD_ID} mode="edit" />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy hồ sơ bé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Về danh sách hồ sơ" }),
    ).toHaveAttribute("href", "/children");
  });

  it("renders mobile viewport with a single top back link and single-mounted form", async () => {
    installMobileMatchMedia(true);
    apiFetchFixture.mockResolvedValueOnce(Response.json(childFixture));

    render(
      <AppServicesProvider>
        <ChildProfileScreen childId={TEST_CHILD_ID} mode="edit" />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: `Hồ sơ của ${childFixture.alias}`,
      }),
    ).toBeInTheDocument();

    const backLinks = screen.getAllByRole("link", { name: "Quay lại" });
    expect(backLinks).toHaveLength(1);
    expect(backLinks[0]).toHaveAttribute("href", "/children");
    expect(backLinks[0]?.className).toContain("min-h-11");
    expect(screen.getAllByLabelText("Tên gọi của bé")).toHaveLength(1);
    expect(
      screen.getAllByRole("heading", { name: "Thông tin của bé" }),
    ).toHaveLength(1);
  });
});

describe("SelectedChildIdentity and ChildProfileCard mobile touch contracts", () => {
  it("gives SelectedChildIdentity switch-profile link at least 44px touch target", () => {
    render(<SelectedChildIdentity child={childFixture} />);
    const link = screen.getByRole("link", { name: "Đổi hồ sơ" });
    expect(link).toHaveAttribute("href", "/dashboard?focus=child-selection");
    expect(link.className).toContain("min-h-11");
  });

  it("keeps ChildProfileCard selected badge non-wrapping", () => {
    render(<ChildProfileCard child={childFixture} selected />);
    const badge = screen.getByText("Đang chọn");
    expect(badge.className).toContain("whitespace-nowrap");
    expect(badge.className).toContain("shrink-0");
  });
});
