import { act, render, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthRuntimeContext,
  AuthServiceProvider,
} from "@/components/auth/auth-service-provider";
import type { AuthService } from "@/lib/api/auth-service";
import { AuthServiceError } from "@/lib/api/auth-service";
import {
  createAuthServiceFixture,
  authSessionFixture,
} from "@/test/fixtures/auth-service-fixture";

const { createSupabaseAuthServiceMock } = vi.hoisted(() => ({
  createSupabaseAuthServiceMock: vi.fn<() => AuthService>(),
}));
vi.mock("@/lib/supabase/auth-service", () => ({
  createSupabaseAuthService: createSupabaseAuthServiceMock,
}));
function RuntimeProbe() {
  const runtime = useContext(AuthRuntimeContext);
  return <output aria-label="Auth runtime">{JSON.stringify(runtime)}</output>;
}
let service: ReturnType<typeof createAuthServiceFixture>;
let unsubscribe = vi.fn<() => void>();
describe("AuthServiceProvider", () => {
  beforeEach(() => {
    service = createAuthServiceFixture();
    unsubscribe = vi.fn<() => void>();
    service.onAuthStateChange.mockReturnValue(unsubscribe);
    createSupabaseAuthServiceMock.mockReset().mockReturnValue(service);
  });

  it("subscribes before initializing Supabase and cleans up", async () => {
    const view = render(
      <AuthServiceProvider mode="supabase" scenario="default">
        <RuntimeProbe />
      </AuthServiceProvider>,
    );
    expect(createSupabaseAuthServiceMock).toHaveBeenCalledOnce();
    expect(service.onAuthStateChange.mock.invocationCallOrder[0]).toBeLessThan(
      service.initialize.mock.invocationCallOrder[0],
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
        '"status":"ready"',
      ),
    );
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps deprecated mock props on the Supabase runtime instead of selecting a removed mock", async () => {
    render(
      <AuthServiceProvider mode="mock" scenario="empty">
        <RuntimeProbe />
      </AuthServiceProvider>,
    );
    expect(createSupabaseAuthServiceMock).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
        '"status":"ready"',
      ),
    );
    expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
      '"mode":"supabase"',
    );
  });

  it("tracks recovery and clears its flag after a signed-out event", async () => {
    render(
      <AuthServiceProvider mode="supabase" scenario="default">
        <RuntimeProbe />
      </AuthServiceProvider>,
    );
    await waitFor(() => expect(service.initialize).toHaveBeenCalledOnce());
    const listener = service.onAuthStateChange.mock.calls[0][0];
    await act(async () => {
      listener("PASSWORD_RECOVERY", authSessionFixture);
    });
    expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
      '"isPasswordRecovery":true',
    );
    await act(async () => {
      listener("SIGNED_OUT", null);
    });
    expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
      '"isPasswordRecovery":false',
    );
    expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
      '"session":null',
    );
  });

  it("maps initialization failure without reflecting sensitive provider details", async () => {
    service.initialize.mockRejectedValue(
      new AuthServiceError(
        "expired-recovery-context",
        "Sensitive provider details",
      ),
    );
    render(
      <AuthServiceProvider mode="supabase" scenario="default">
        <RuntimeProbe />
      </AuthServiceProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
        '"status":"error"',
      ),
    );
    expect(screen.getByLabelText("Auth runtime")).toHaveTextContent(
      '"initializationFailure":"expired-recovery-context"',
    );
    expect(
      screen.queryByText(/Sensitive provider details/),
    ).not.toBeInTheDocument();
  });

  it("ignores delayed initialization and auth events after unmount", async () => {
    let settle: () => void = () => undefined;
    service.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const view = render(
      <AuthServiceProvider mode="supabase" scenario="default">
        <RuntimeProbe />
      </AuthServiceProvider>,
    );
    const listener = service.onAuthStateChange.mock.calls[0][0];
    view.unmount();
    await act(async () => {
      settle();
      listener("SIGNED_IN", authSessionFixture);
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(view.container).toBeEmptyDOMElement();
  });
});
