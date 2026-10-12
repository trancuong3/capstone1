import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/layout/app-shell";
import {
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

const { refreshMock, replaceMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));

describe("parent logout", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    replaceMock.mockClear();
  });
  it("awaits sign-out and replaces history with login", async () => {
    const service = createAuthServiceFixture();
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));
    await user.click(screen.getByRole("button", { name: "Đăng xuất" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
    expect(service.signOut).toHaveBeenCalledOnce();
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
