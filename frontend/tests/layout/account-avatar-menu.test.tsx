import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AccountAvatarMenu } from "@/components/layout/account-avatar-menu";

describe("AccountAvatarMenu", () => {
  it("uses the first display-name initial and exposes account links", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName="Nguyễn Minh Anh"
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role="Phụ huynh"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));

    expect(
      screen.getByRole("button", { name: "Mở menu tài khoản" }),
    ).toHaveTextContent("N");
    expect(screen.getByText("Nguyễn Minh Anh")).toBeInTheDocument();
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Hồ sơ ba mẹ" }),
    ).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("menuitem", { name: "Hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children",
    );
    expect(screen.getByRole("menuitem", { name: "Cài đặt" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(
      screen.getByRole("menuitem", { name: "Trợ giúp & hỗ trợ" }),
    ).toHaveAttribute("href", "/help-support");
  });

  it("falls back to the email initial and closes with Escape while restoring focus", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName={null}
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role={null}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Mở menu tài khoản" });
    await user.click(trigger);
    expect(trigger).toHaveTextContent("P");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("supports arrow, Home and End item navigation", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName="Parent"
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role="Phụ huynh"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const parentProfile = screen.getByRole("menuitem", { name: "Hồ sơ ba mẹ" });
    const childProfile = screen.getByRole("menuitem", { name: "Hồ sơ bé" });
    const logout = screen.getByRole("menuitem", { name: "Đăng xuất" });

    expect(parentProfile).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(childProfile).toHaveFocus();
    await user.keyboard("{Home}");
    expect(parentProfile).toHaveFocus();
    await user.keyboard("{End}");
    expect(logout).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByRole("menuitem", { name: "Trợ giúp & hỗ trợ" }),
    ).toHaveFocus();
  });

  it("closes when clicking outside and invokes the existing sign-out callback", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <div>
        <AccountAvatarMenu
          displayName="Parent"
          email="parent@example.com"
          isSigningOut={false}
          onSignOut={onSignOut}
          role="Phụ huynh"
        />
        <button type="button">Outside</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("menuitem", { name: "Đăng xuất" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
