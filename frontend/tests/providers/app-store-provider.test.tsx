import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import { clearApiReadCache, runCoalescedApiGet } from "@/lib/api/read-cache";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import type { ChildProfileDTO } from "@/types/child";

const CHILD_ONE: ChildProfileDTO = {
  id: "child-one",
  parent_id: authSessionFixture.user.id,
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-10-01T00:00:00Z",
};

const CHILD_TWO: ChildProfileDTO = {
  id: "child-two",
  parent_id: authSessionFixture.user.id,
  alias: "Bé Bình",
  grade: 3,
  settings: {},
  created_at: "2026-10-02T00:00:00Z",
};

function StoreControls({
  childrenFixtures = [CHILD_ONE],
}: {
  childrenFixtures?: readonly ChildProfileDTO[];
}) {
  const {
    selectedChildId,
    validatedSelectedChild,
    selectChild,
    clearSelectedChild,
    syncAvailableChildren,
  } = useAppStore();
  return (
    <div>
      <output aria-label="Selected child">{selectedChildId ?? "none"}</output>
      <output aria-label="Validated child">
        {validatedSelectedChild?.alias ?? "none"}
      </output>
      <button onClick={() => selectChild("child-one")} type="button">
        Select one
      </button>
      <button onClick={() => selectChild("child-two")} type="button">
        Select two
      </button>
      <button onClick={clearSelectedChild} type="button">
        Clear
      </button>
      <button
        onClick={() => syncAvailableChildren(childrenFixtures)}
        type="button"
      >
        Sync children
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
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    clearApiReadCache();
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

  it("does not touch localStorage when no authenticated userId is active", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    try {
      const { unmount } = render(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Select one" }));
      expect(getItem).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      unmount();
      render(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
      );
      expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });

  it("persists selected child in localStorage keyed by userId and restores across provider remounts", async () => {
    const user = userEvent.setup();
    const authService = createAuthServiceFixture();
    const storageKey = `viread:selected-child:${authSessionFixture.user.id}`;

    const { unmount } = render(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    await user.click(screen.getByRole("button", { name: "Select one" }));
    expect(window.localStorage.getItem(storageKey)).toBe("child-one");
    unmount();

    render(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-one",
    );

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("hydrates persisted localStorage selection on client mount without SSR hydration mismatch", async () => {
    const authService = createAuthServiceFixture();
    const storageKey = `viread:selected-child:${authSessionFixture.user.id}`;
    window.localStorage.setItem(storageKey, "child-persisted");

    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const element = withAuthFixture(
      <AppStoreProvider>
        <StoreControls />
      </AppStoreProvider>,
      authService,
      { initialUserId: authSessionFixture.user.id, session: null },
    );

    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockReturnValue(null);
    const ssrHtml = renderToString(element);
    getItemSpy.mockRestore();

    const container = document.createElement("div");
    container.innerHTML = ssrHtml;
    document.body.appendChild(container);

    const consoleErrors: unknown[][] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        consoleErrors.push(args);
      });

    let root: ReturnType<typeof hydrateRoot> | null = null;
    try {
      await act(async () => {
        root = hydrateRoot(container, element);
      });
      expect(consoleErrors).toEqual([]);
      await waitFor(() =>
        expect(
          within(container).getByLabelText("Selected child"),
        ).toHaveTextContent("child-persisted"),
      );
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it("purges persisted selection on user switch and on SIGNED_OUT without leaking between users", async () => {
    const user = userEvent.setup();
    const authService = createAuthServiceFixture();
    const userA = authSessionFixture;
    const userB = {
      ...authSessionFixture,
      user: {
        ...authSessionFixture.user,
        id: "parent-user-b",
        email: "parent-b@example.com",
      },
    };
    const keyA = `viread:selected-child:${userA.user.id}`;
    const keyB = `viread:selected-child:${userB.user.id}`;

    const { rerender } = render(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
        authService,
        { session: userA },
      ),
    );

    await user.click(screen.getByRole("button", { name: "Select one" }));
    expect(window.localStorage.getItem(keyA)).toBe("child-one");

    rerender(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
        authService,
        { session: userB },
      ),
    );

    expect(window.localStorage.getItem(keyA)).toBeNull();
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");

    await user.click(screen.getByRole("button", { name: "Select two" }));
    expect(window.localStorage.getItem(keyB)).toBe("child-two");

    rerender(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls />
        </AppStoreProvider>,
        authService,
        { session: null, lastEvent: "SIGNED_OUT" },
      ),
    );

    expect(window.localStorage.getItem(keyB)).toBeNull();
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
  });

  it("auto-selects and persists the single child via syncAvailableChildren, while leaving multi-child and invalid selections untouched", async () => {
    const user = userEvent.setup();
    const authService = createAuthServiceFixture();
    const storageKey = `viread:selected-child:${authSessionFixture.user.id}`;

    const { rerender } = render(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls childrenFixtures={[CHILD_ONE, CHILD_TWO]} />
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    await user.click(screen.getByRole("button", { name: "Sync children" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent("none");
    expect(window.localStorage.getItem(storageKey)).toBeNull();

    rerender(
      withAuthFixture(
        <AppStoreProvider>
          <StoreControls childrenFixtures={[CHILD_ONE]} />
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    await user.click(screen.getByRole("button", { name: "Sync children" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-one",
    );
    expect(screen.getByLabelText("Validated child")).toHaveTextContent("Bé An");
    expect(window.localStorage.getItem(storageKey)).toBe("child-one");

    await user.click(screen.getByRole("button", { name: "Select two" }));
    await user.click(screen.getByRole("button", { name: "Sync children" }));
    expect(screen.getByLabelText("Selected child")).toHaveTextContent(
      "child-two",
    );
  });
});
