import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSupabaseAuthServiceMock,
  initializeMock,
  onAuthStateChangeMock,
  unsubscribeMock,
} = vi.hoisted(() => ({
  createSupabaseAuthServiceMock: vi.fn(),
  initializeMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(),
  unsubscribeMock: vi.fn(),
}));

vi.mock("@/lib/supabase/auth-service", () => ({
  createSupabaseAuthService: createSupabaseAuthServiceMock,
}));

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";

describe("AuthServiceProvider", () => {
  beforeEach(() => {
    createSupabaseAuthServiceMock.mockReset();
    initializeMock.mockReset().mockResolvedValue(undefined);
    onAuthStateChangeMock.mockReset().mockReturnValue(unsubscribeMock);
    unsubscribeMock.mockReset();
    createSupabaseAuthServiceMock.mockReturnValue({
      initialize: initializeMock,
      onAuthStateChange: onAuthStateChangeMock,
    });
  });

  it("subscribes before initializing Supabase and cleans up", async () => {
    const { unmount } = render(
      <AuthServiceProvider mode="supabase" scenario="default">
        <div>Auth child</div>
      </AuthServiceProvider>,
    );

    expect(screen.getByText("Auth child")).toBeInTheDocument();
    expect(createSupabaseAuthServiceMock).toHaveBeenCalledOnce();
    expect(onAuthStateChangeMock).toHaveBeenCalledOnce();
    expect(initializeMock).toHaveBeenCalledOnce();
    expect(onAuthStateChangeMock.mock.invocationCallOrder[0]).toBeLessThan(
      initializeMock.mock.invocationCallOrder[0],
    );

    await waitFor(() => expect(initializeMock).toHaveBeenCalledOnce());
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledOnce();
  });

  it("keeps explicit mock mode isolated from the Supabase factory", () => {
    render(
      <AuthServiceProvider mode="mock" scenario="default">
        <div>Mock child</div>
      </AuthServiceProvider>,
    );

    expect(screen.getByText("Mock child")).toBeInTheDocument();
    expect(createSupabaseAuthServiceMock).not.toHaveBeenCalled();
  });
});
