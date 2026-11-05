import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  getAvatarInitial,
  ProfileAvatar,
  resolveDisplayName,
} from "@/components/common/profile-avatar";

describe("ProfileAvatar", () => {
  it("uses the first Vietnamese character when no custom image exists", () => {
    render(
      <ProfileAvatar
        ariaLabel="Ảnh đại diện tài khoản"
        displayName="  Nguyễn An"
      />,
    );

    expect(
      screen.getByRole("img", { name: "Ảnh đại diện tài khoản" }),
    ).toHaveTextContent("N");
    expect(getAvatarInitial("   ")).toBe("?");
  });

  it("shows an uploaded image and falls back to the initial if it fails to load", () => {
    render(
      <ProfileAvatar
        ariaLabel="Ảnh đại diện"
        displayName="Bé An"
        imageUrl="https://storage.example/signed-avatar"
      />,
    );

    const image = screen
      .getByRole("img", { name: "Ảnh đại diện" })
      .querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      "https://storage.example/signed-avatar",
    );
    expect(image).toHaveClass("opacity-0");
    fireEvent.load(image as HTMLImageElement);
    expect(image).toHaveClass("opacity-100");
    fireEvent.error(image as HTMLImageElement);
    expect(screen.getByRole("img", { name: "Ảnh đại diện" })).toHaveTextContent(
      "B",
    );
  });

  it("prefers the profile name, then OAuth metadata, then the email name", () => {
    expect(
      resolveDisplayName("Profile Name", "OAuth Name", "user@example.com"),
    ).toBe("Profile Name");
    expect(resolveDisplayName(null, "OAuth Name", "user@example.com")).toBe(
      "OAuth Name",
    );
    expect(resolveDisplayName(null, null, "user@example.com")).toBe("user");
  });
});
