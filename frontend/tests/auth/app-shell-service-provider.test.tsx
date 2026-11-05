import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/layout/app-shell";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: supabaseMocks,
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  installApiFetchFixture();
  supabaseMocks.getSession.mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("AppShell service provider boundary", () => {
  it("loads the persisted account menu inside AppServicesProvider", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        id: "10000000-0000-4000-8000-000000000001",
        display_name: "Ba mẹ đã lưu",
        role: "parent",
        created_at: "2026-10-01T00:00:00Z",
        email: "parent@example.com",
        contact_phone: null,
        pending_email: null,
        email_verified: true,
        contact_info_status: "available",
        avatar_url: "https://storage.example/avatar.webp",
        children: [],
      }),
    );

    const authService = createAuthServiceFixture();
    render(
      withAuthFixture(
        <AppServicesProvider>
          <AppShell>Dashboard</AppShell>
        </AppServicesProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Mở menu tài khoản" }),
    );
    expect(screen.getByText("Ba mẹ đã lưu")).toBeInTheDocument();
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(apiFetchFixture).toHaveBeenCalledOnce();
    expect(authService.getCurrentUser).not.toHaveBeenCalled();
  });
});
