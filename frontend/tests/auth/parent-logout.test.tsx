import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthServiceContext } from "@/components/auth/auth-service-provider";
import { AppShell } from "@/components/layout/app-shell";
import { createMockAuthService } from "@/lib/mock/mock-auth-service";

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

  it("clears the auth session and replaces history with login", async () => {
    const service = createMockAuthService("default");
    const signOut = vi.spyOn(service, "signOut");
    const user = userEvent.setup();
    render(
      <AuthServiceContext.Provider value={service}>
        <AppShell>Dashboard content</AppShell>
      </AuthServiceContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Đăng xuất" }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(replaceMock).toHaveBeenCalledWith("/login");
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
