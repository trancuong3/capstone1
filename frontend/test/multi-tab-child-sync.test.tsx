import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { ServiceError } from "@/lib/api/service-error";
import type { ChildProfileDTO } from "@/types/child";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: vi.fn() }),
}));

function makeRuntime(
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

function makeChild(id: string, alias: string): ChildProfileDTO {
  return {
    id,
    parent_id: "parent-1",
    alias,
    grade: 2,
    settings: {},
    created_at: "2026-10-01T00:00:00Z",
  };
}

function StoreInspector() {
  const { selectedChildId, selectChild, clearSelectedChild } = useAppStore();
  return (
    <div>
      <output aria-label="Selected child">{selectedChildId ?? "none"}</output>
      <button onClick={() => selectChild("child-a")} type="button">
        Select A
      </button>
      <button onClick={() => selectChild("child-b")} type="button">
        Select B
      </button>
      <button onClick={clearSelectedChild} type="button">
        Clear
      </button>
    </div>
  );
}

function ValidatedChildProbe() {
  const { selectChild } = useAppStore();
  const { state } = useValidatedSelectedChild();
  return (
    <div>
      <output aria-label="Child status">{state.status}</output>
      <output aria-label="Child alias">
        {state.status === "ready" ? state.child.alias : "none"}
      </output>
      <button onClick={() => selectChild("child-a")} type="button">
        Switch A
      </button>
      <button onClick={() => selectChild("child-b")} type="button">
        Switch B
      </button>
    </div>
  );
}

describe("DEF-011 multi-tab and session-scoped child selection sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    replaceMock.mockReset();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("does not persist selectedChildId across cold mounts and clears across users/logout", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AuthRuntimeContext.Provider value={makeRuntime("user-1")}>
        <AppStoreProvider>
          <StoreInspector />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Select A" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-a",
    );
    expect(
      window.localStorage.getItem("viread:selected-child:user-1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("viread:selected-child-signal"),
    ).toBeNull();

    // Switch to another user directly -> must not inherit user-1 selection
    rerender(
      <AuthRuntimeContext.Provider value={makeRuntime("user-2")}>
        <AppStoreProvider>
          <StoreInspector />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");

    // Select child-b for user-2, then sign out -> clears in-memory selection and broadcasts null
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    await user.click(screen.getByRole("button", { name: "Select B" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-b",
    );

    rerender(
      <AuthRuntimeContext.Provider
        value={makeRuntime(null, { lastEvent: "SIGNED_OUT" })}
      >
        <AppStoreProvider>
          <StoreInspector />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    expect(
      window.localStorage.getItem("viread:selected-child:user-2"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("viread:selected-child-signal"),
    ).toBeNull();
    expect(
      setItemSpy.mock.calls.some(([key, value]) => {
        if (key !== "viread:selected-child-signal") return false;
        const parsed = JSON.parse(value) as {
          userId: string;
          childId: string | null;
        };
        return parsed.userId === "user-2" && parsed.childId === null;
      }),
    ).toBe(true);
    setItemSpy.mockRestore();
  });

  it("synchronizes child selection and clears across open tabs via storage signal events", async () => {
    render(
      <AuthRuntimeContext.Provider value={makeRuntime("user-1")}>
        <AppStoreProvider>
          <StoreInspector />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");

    // Another tab selects child-b for user-1 via transient signal event
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "viread:selected-child-signal",
          newValue: JSON.stringify({
            userId: "user-1",
            childId: "child-b",
            nonce: "n-1",
          }),
          storageArea: window.localStorage,
        }),
      );
    });
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-b",
    );

    // Signal event for a different user must be ignored
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "viread:selected-child-signal",
          newValue: JSON.stringify({
            userId: "user-2",
            childId: "child-a",
            nonce: "n-2",
          }),
          storageArea: window.localStorage,
        }),
      );
    });
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-b",
    );

    // Direct legacy storage event is also handled when explicitly dispatched
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "viread:selected-child:user-1",
          newValue: "child-a",
          storageArea: window.localStorage,
        }),
      );
    });
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-a",
    );

    // Another tab clears selection via signal event
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "viread:selected-child-signal",
          newValue: JSON.stringify({
            userId: "user-1",
            childId: null,
            nonce: "n-3",
          }),
          storageArea: window.localStorage,
        }),
      );
    });
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
  });

  it("cold mount without explicit childId does not auto-restore a prior tab selection", async () => {
    const user = userEvent.setup();
    const firstMount = render(
      <AuthRuntimeContext.Provider value={makeRuntime("user-1")}>
        <AppStoreProvider>
          <StoreInspector />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "Select A" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-a",
    );
    firstMount.unmount();

    // Fresh cold mount (e.g. direct navigation to /books/<id> without ?childId=)
    render(
      <AuthRuntimeContext.Provider value={makeRuntime("user-1")}>
        <AppStoreProvider>
          <StoreInspector />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
  });

  it("waits for auth initialization and cancels stale async child fetches on rapid switch", async () => {
    let resolveA!: (value: ChildProfileDTO) => void;
    let rejectA!: (reason?: unknown) => void;
    let resolveB!: (value: ChildProfileDTO) => void;
    let call = 0;

    const getChild = vi.fn((childId: string) => {
      call += 1;
      if (childId === "child-a" && call === 1) {
        return new Promise<ChildProfileDTO>((resolve, reject) => {
          resolveA = resolve;
          rejectA = reject;
        });
      }
      return new Promise<ChildProfileDTO>((resolve) => {
        resolveB = resolve;
      });
    });

    const services = {
      childService: { get: getChild },
    } as unknown as AppServices;

    // While auth is initializing, hook must wait instead of redirecting prematurely
    const { rerender } = render(
      <AuthRuntimeContext.Provider
        value={makeRuntime(null, {
          hasProvider: true,
          lastEvent: null,
          status: "initializing",
        })}
      >
        <AppServicesContext.Provider value={services}>
          <AppStoreProvider initialChildId="child-a">
            <ValidatedChildProbe />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    expect(screen.getByLabelText("Child status")).toHaveTextContent("loading");
    expect(replaceMock).not.toHaveBeenCalled();

    // Auth finishes initializing -> loads explicit initialChildId child-a
    rerender(
      <AuthRuntimeContext.Provider value={makeRuntime("user-1")}>
        <AppServicesContext.Provider value={services}>
          <AppStoreProvider initialChildId="child-a">
            <ValidatedChildProbe />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() => expect(getChild).toHaveBeenCalledWith("child-a"));

    // Rapid switch to child-b in another tab before child-a resolves
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "viread:selected-child-signal",
          newValue: JSON.stringify({
            userId: "user-1",
            childId: "child-b",
            nonce: "n-4",
          }),
          storageArea: window.localStorage,
        }),
      );
    });

    await waitFor(() => expect(getChild).toHaveBeenCalledWith("child-b"));
    expect(screen.getByLabelText("Child status")).toHaveTextContent("loading");

    // Stale child-a rejection with 404 must NOT clear child-b or redirect
    await act(async () => {
      rejectA(
        new ServiceError({
          code: "RESOURCE_NOT_FOUND",
          message: "Not found",
          status: 404,
          request_id: "req-1",
          retryable: false,
        }),
      );
    });
    expect(replaceMock).not.toHaveBeenCalled();

    // Even if resolveA was called (guard check), child-b resolves cleanly
    resolveA?.(makeChild("child-a", "Bé A"));
    await act(async () => {
      resolveB(makeChild("child-b", "Bé B"));
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Child status")).toHaveTextContent("ready"),
    );
    expect(screen.getByLabelText("Child alias")).toHaveTextContent("Bé B");
  });
});
