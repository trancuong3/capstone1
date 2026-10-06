import { describe, expect, it, vi } from "vitest";

import { createMockAuthService } from "@/lib/mock/mock-auth-service";

describe("mock AuthService session contract", () => {
  it("starts signed out and establishes a parent session after login", async () => {
    const service = createMockAuthService("default");

    await expect(service.getSession()).resolves.toBeNull();
    await service.signIn({
      email: "minhanh@example.com",
      password: "password123",
    });

    await expect(service.getCurrentUser()).resolves.toMatchObject({
      email: "minhanh@example.com",
    });
    await expect(service.getCurrentRole()).resolves.toBe("parent");
  });

  it("returns an authenticated registration result", async () => {
    const service = createMockAuthService("default");

    await expect(
      service.registerParent({
        displayName: "Nguyen Minh Anh",
        email: "minhanh@example.com",
        password: "password123",
      }),
    ).resolves.toMatchObject({
      status: "authenticated",
      session: { user: { email: "minhanh@example.com" } },
    });
  });

  it("uses the same neutral registration outcome for an existing email", async () => {
    const service = createMockAuthService("email-used");

    await expect(
      service.registerParent({
        displayName: "Nguyen Minh Anh",
        email: "minhanh@example.com",
        password: "password123",
      }),
    ).resolves.toEqual({
      status: "email-confirmation-required",
      session: null,
    });
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const service = createMockAuthService("default");
    const listener = vi.fn();
    const unsubscribe = service.onAuthStateChange(listener);

    await service.signIn({
      email: "minhanh@example.com",
      password: "password123",
    });
    await service.signOut();

    expect(listener).toHaveBeenNthCalledWith(1, "INITIAL_SESSION", null);
    expect(listener).toHaveBeenNthCalledWith(
      2,
      "SIGNED_IN",
      expect.any(Object),
    );
    expect(listener).toHaveBeenNthCalledWith(3, "SIGNED_OUT", null);

    unsubscribe();
    await service.signIn({
      email: "minhanh@example.com",
      password: "password123",
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
