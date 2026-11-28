import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getApiBaseUrlMock, getSessionMock } = vi.hoisted(() => ({
  getApiBaseUrlMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/login",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: getApiBaseUrlMock,
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: { getSession: getSessionMock },
  }),
}));

import { LoginScreen } from "@/components/auth/login-screen";
import { resetAllApiCachesForTests } from "@/lib/api/read-cache";
import {
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

describe("LoginScreen Render health warm-up", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetAllApiCachesForTests();
    getApiBaseUrlMock.mockReset().mockReturnValue("https://api.example.com");
    getSessionMock.mockReset();
    fetchMock
      .mockReset()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetAllApiCachesForTests();
  });

  it("sends a non-blocking unauthenticated GET /health warm-up on mount and throttles repeats within 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);

    const view = render(
      withAuthFixture(
        <LoginScreen scenario="default" />,
        createAuthServiceFixture(),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/health",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(getSessionMock).not.toHaveBeenCalled();

    // Re-mounting within cooldown skips redundant /health warm-up
    view.unmount();
    render(
      withAuthFixture(
        <LoginScreen scenario="default" />,
        createAuthServiceFixture(),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After 60s cooldown, warm-up fires again
    vi.advanceTimersByTime(60_001);
    render(
      withAuthFixture(
        <LoginScreen scenario="default" />,
        createAuthServiceFixture(),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips warm-up in loading scenario and never throws when NEXT_PUBLIC_API_URL is unset or /health fails", () => {
    render(
      withAuthFixture(
        <LoginScreen scenario="loading" />,
        createAuthServiceFixture(),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    getApiBaseUrlMock.mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_API_URL missing");
    });
    expect(() =>
      render(
        withAuthFixture(
          <LoginScreen scenario="default" />,
          createAuthServiceFixture(),
        ),
      ),
    ).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    getApiBaseUrlMock.mockReturnValue("https://api.example.com");
    fetchMock.mockRejectedValueOnce(new TypeError("cold start failure"));
    expect(() =>
      render(
        withAuthFixture(
          <LoginScreen scenario="default" />,
          createAuthServiceFixture(),
        ),
      ),
    ).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
