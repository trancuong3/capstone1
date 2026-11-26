import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { clearApiReadCache, runCoalescedApiGet } from "@/lib/api/read-cache";
import { ServiceError } from "@/lib/api/service-error";
import type { ChildProfileDTO } from "@/types/child";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: vi.fn() }),
}));

function makeAuthRuntime(
  userId: string | null,
  overrides: Partial<AuthRuntimeState> = {},
): AuthRuntimeState {
  return {
    hasProvider: true,
    initializationFailure: null,
    isPasswordRecovery: false,
    lastEvent: userId ? "SIGNED_IN" : "SIGNED_OUT",
    mode: "supabase",
    session: userId
      ? {
          expires_at: null,
          user: {
            id: userId,
            email: `${userId}@example.com`,
            display_name: userId,
          },
        }
      : null,
    status: "ready",
    ...overrides,
  };
}

function makeChild(id: string, parentId: string): ChildProfileDTO {
  return {
    id,
    parent_id: parentId,
    alias: "Bé An",
    grade: 2,
    settings: {},
    created_at: "2026-11-26T00:00:00Z",
  };
}

function ValidatedProbe() {
  const { selectedChildId } = useAppStore();
  const { state } = useValidatedSelectedChild();
  return (
    <div>
      <output aria-label="Probe selected">{selectedChildId ?? "none"}</output>
      <output aria-label="Probe status">{state.status}</output>
    </div>
  );
}

function StoreControls() {
  const { selectedChildId, selectChild, clearSelectedChild } = useAppStore();
  return (
    <div>
      <output aria-label="Selected child">{selectedChildId ?? "none"}</output>
      <button onClick={() => selectChild("child-one")} type="button">
        Select one
      </button>
      <button onClick={() => selectChild("child-two")} type="button">
        Select two
      </button>
      <button onClick={clearSelectedChild} type="button">
        Clear
      </button>
    </div>
  );
}

function NavigationHarness() {
  const [route, setRoute] = useState("dashboard");
  return (
    <AppStoreProvider>
      <StoreControls />
      <button onClick={() => setRoute("books")} type="button">
        Navigate
      </button>
      <output aria-label="Route">{route}</output>
    </AppStoreProvider>
  );
}

describe("AppStoreProvider", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    replaceMock.mockReset();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("does not abort an in-flight API read on initial provider mount", async () => {
    let sharedSignal: AbortSignal | undefined;
    let finishRead!: (value: string) => void;
    const read = runCoalescedApiGet(
      "/reading/sessions/test",
      "test-token",
      undefined,
      (signal) => {
        sharedSignal = signal;
        return new Promise<string>((resolve, reject) => {
          finishRead = resolve;
          signal.addEventListener(
            "abort",
            () => reject(new Error("Read aborted")),
            { once: true },
          );
        });
      },
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    try {
      render(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
      );
      expect(sharedSignal?.aborted).toBe(false);
      finishRead("loaded");
      await expect(read).resolves.toEqual({ value: "loaded" });
    } finally {
      clearApiReadCache();
      await read;
    }
  });

  it("starts empty, selects one child at a time, and clears the selection", async () => {
    const user = userEvent.setup();
    render(
      <AppStoreProvider>
        <StoreControls />
      </AppStoreProvider>,
    );
    const selected = screen.getByLabelText("Selected child");
    expect(selected).toHaveTextContent("none");
    await user.click(screen.getByRole("button", { name: "Select one" }));
    expect(selected).toHaveTextContent("child-one");
    await user.click(screen.getByRole("button", { name: "Select two" }));
    expect(selected).toHaveTextContent("child-two");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(selected).toHaveTextContent("none");
  });

  it("keeps the in-memory selection across navigation under the parent layout", async () => {
    const user = userEvent.setup();
    render(<NavigationHarness />);
    await user.click(screen.getByRole("button", { name: "Select one" }));
    await user.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByLabelText("Route")).toHaveTextContent("books");
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-one",
    );
  });

  it("does not use browser storage when unauthenticated and starts empty after a provider remount", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const { unmount } = render(
      <AppStoreProvider>
        <StoreControls />
      </AppStoreProvider>,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Select one" }));
    expect(getItem).not.toHaveBeenCalled();
    unmount();
    render(
      <AppStoreProvider>
        <StoreControls />
      </AppStoreProvider>,
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it("persists selectedChildId in user-scoped sessionStorage across F5 reload and auth hydration", async () => {
    const user = userEvent.setup();
    const firstMount = render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-1")}>
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Select one" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-one",
    );
    expect(
      window.sessionStorage.getItem("viread:selected-child:parent-1"),
    ).toBe("child-one");
    expect(
      window.localStorage.getItem("viread:selected-child:parent-1"),
    ).toBeNull();
    firstMount.unmount();

    // Simulate F5 reload on a child-gated route (/books): AuthServiceProvider starts
    // initializing (session=null) then hydrates to parent-1; child must restore without redirect.
    const getChild = vi
      .fn()
      .mockResolvedValue(makeChild("child-one", "parent-1"));
    const services = {
      childService: { get: getChild },
    } as unknown as AppServices;
    const reloaded = render(
      <AuthRuntimeContext.Provider
        value={makeAuthRuntime(null, {
          lastEvent: null,
          status: "initializing",
        })}
      >
        <AppServicesContext.Provider value={services}>
          <AppStoreProvider>
            <ValidatedProbe />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );
    expect(screen.getByLabelText("Probe status")).toHaveTextContent("loading");

    reloaded.rerender(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-1")}>
        <AppServicesContext.Provider value={services}>
          <AppStoreProvider>
            <ValidatedProbe />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Probe status")).toHaveTextContent("ready"),
    );
    expect(screen.getByLabelText("Probe selected")).toHaveTextContent(
      "child-one",
    );
    expect(getChild).toHaveBeenCalledWith("child-one");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("rejects stale or invalid persisted selectedChildId and purges sessionStorage", async () => {
    window.sessionStorage.setItem(
      "viread:selected-child:parent-1",
      "stale-child-id",
    );
    const getChild = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "RESOURCE_NOT_FOUND",
        message: "Child not found",
        status: 404,
        request_id: "req-stale",
        retryable: false,
      }),
    );
    const services = {
      childService: { get: getChild },
    } as unknown as AppServices;

    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-1")}>
        <AppServicesContext.Provider value={services}>
          <AppStoreProvider>
            <ValidatedProbe />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=invalid",
      ),
    );
    expect(screen.getByLabelText("Probe selected")).toHaveTextContent("none");
    expect(
      window.sessionStorage.getItem("viread:selected-child:parent-1"),
    ).toBeNull();
  });

  it("clears persisted selectedChildId on sign-out and isolates across parent accounts", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-1")}>
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Select one" }));
    expect(
      window.sessionStorage.getItem("viread:selected-child:parent-1"),
    ).toBe("child-one");

    // Switching parent account must clear previous user's persisted selection (zero leakage)
    rerender(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-2")}>
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    expect(
      window.sessionStorage.getItem("viread:selected-child:parent-1"),
    ).toBeNull();

    // Select for parent-2 then sign out -> wipes sessionStorage cleanly
    await user.click(screen.getByRole("button", { name: "Select two" }));
    expect(
      window.sessionStorage.getItem("viread:selected-child:parent-2"),
    ).toBe("child-two");

    rerender(
      <AuthRuntimeContext.Provider
        value={makeAuthRuntime(null, { lastEvent: "SIGNED_OUT" })}
      >
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    expect(
      window.sessionStorage.getItem("viread:selected-child:parent-2"),
    ).toBeNull();
  });
});
