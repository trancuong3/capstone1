import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";

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

  it("does not use browser storage and starts empty after a provider remount", async () => {
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
  });
});
