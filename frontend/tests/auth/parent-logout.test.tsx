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
const { getProfileMock, profileServiceMock } = vi.hoisted(() => {
  const getProfileMock = vi.fn();
  return { getProfileMock, profileServiceMock: { get: getProfileMock } };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));
vi.mock("@/hooks/use-profile-service", () => ({
  useProfileService: () => profileServiceMock,
}));

describe("parent logout", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    replaceMock.mockClear();
    getProfileMock.mockResolvedValue(null);
  });
  it("awaits sign-out and replaces history with login", async () => {
    const service = createAuthServiceFixture();
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));
    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("menuitem", { name: "Đăng xuất" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
    expect(service.signOut).toHaveBeenCalledOnce();
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("shows parent and child profile links in the avatar menu", async () => {
    const service = createAuthServiceFixture();
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));

    expect(
      await screen.findByRole("menu", { name: "Menu tài khoản" }),
    ).toBeVisible();
    expect(screen.getByText("Test Parent")).toBeInTheDocument();
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Hồ sơ ba mẹ" }),
    ).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("menuitem", { name: "Hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children",
    );
  });

  it("closes the menu on Escape and when clicking outside", async () => {
    const service = createAuthServiceFixture();
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));
    const trigger = screen.getByRole("button", { name: "Mở menu tài khoản" });

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByText("Dashboard content"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles from the avatar and moves focus through menu items by keyboard", async () => {
    const service = createAuthServiceFixture();
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));
    const trigger = screen.getByRole("button", { name: "Mở menu tài khoản" });

    await user.click(trigger);
    const parentProfile = await screen.findByRole("menuitem", {
      name: "Hồ sơ ba mẹ",
    });
    expect(parentProfile).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Hồ sơ bé" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Đăng xuất" })).toHaveFocus();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a loading label while sign-out is pending", async () => {
    const service = createAuthServiceFixture();
    let finishSignOut: () => void = () => undefined;
    service.signOut.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSignOut = resolve;
        }),
    );
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("menuitem", { name: "Đăng xuất" }));
    expect(
      screen.getByRole("menuitem", { name: "Đang đăng xuất…" }),
    ).toBeDisabled();

    finishSignOut();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("shows a safe error when sign-out fails", async () => {
    const service = createAuthServiceFixture();
    service.signOut.mockRejectedValue(new Error("private auth detail"));
    const user = userEvent.setup();
    render(withAuthFixture(<AppShell>Dashboard content</AppShell>, service));

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("menuitem", { name: "Đăng xuất" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Chưa thể đăng xuất lúc này");
    expect(alert).not.toHaveTextContent("private auth detail");
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
