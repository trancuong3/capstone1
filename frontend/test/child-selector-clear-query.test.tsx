import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for Next.js navigation hooks
// ---------------------------------------------------------------------------

const pushMock = vi.fn();
let currentPathname = "/reports/difficult-words";
let currentSearchParams = new URLSearchParams("childId=child-1&word=khủng_long");

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => currentSearchParams,
}));

import { ChildSelector } from "@/components/reports/child-selector";
import type { ChildProfileDTO } from "@/types/child";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILES: ChildProfileDTO[] = [
  {
    id: "child-1",
    parent_id: "parent-1",
    alias: "Bé A",
    grade: 1,
    settings: {},
    created_at: "2026-01-01T00:00:00+07:00",
  },
  {
    id: "child-2",
    parent_id: "parent-1",
    alias: "Bé B",
    grade: 2,
    settings: {},
    created_at: "2026-01-01T00:00:00+07:00",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChildSelector – clearQueryKeys", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("strips the `word` param when clearQueryKeys includes 'word'", async () => {
    currentPathname = "/reports/difficult-words";
    currentSearchParams = new URLSearchParams(
      "childId=child-1&word=khủng_long&days=14",
    );

    render(
      <ChildSelector
        childrenProfiles={PROFILES}
        clearQueryKeys={["word"]}
        selectedChildId="child-1"
      />,
    );

    const select = screen.getByLabelText("Chọn hồ sơ bé để xem dữ liệu");
    await userEvent.selectOptions(select, "child-2");

    expect(pushMock).toHaveBeenCalledOnce();
    const pushedUrl: string = pushMock.mock.calls[0]![0];
    const params = new URLSearchParams(pushedUrl.split("?")[1]);

    // `word` must be gone, `days` must be preserved, `childId` updated.
    expect(params.get("childId")).toBe("child-2");
    expect(params.has("word")).toBe(false);
    expect(params.get("days")).toBe("14");
  });

  it("preserves all params when clearQueryKeys is omitted", async () => {
    currentPathname = "/reports/session-history";
    currentSearchParams = new URLSearchParams(
      "childId=child-1&word=test&days=7",
    );

    render(
      <ChildSelector
        childrenProfiles={PROFILES}
        selectedChildId="child-1"
      />,
    );

    const select = screen.getByLabelText("Chọn hồ sơ bé để xem dữ liệu");
    await userEvent.selectOptions(select, "child-2");

    expect(pushMock).toHaveBeenCalledOnce();
    const params = new URLSearchParams(
      (pushMock.mock.calls[0]![0] as string).split("?")[1],
    );

    expect(params.get("childId")).toBe("child-2");
    // `word` is kept because clearQueryKeys was not provided.
    expect(params.get("word")).toBe("test");
    expect(params.get("days")).toBe("7");
  });

  it("always clears `page` regardless of clearQueryKeys", async () => {
    currentPathname = "/reports/difficult-words";
    currentSearchParams = new URLSearchParams(
      "childId=child-1&page=3&word=cá",
    );

    render(
      <ChildSelector
        childrenProfiles={PROFILES}
        clearQueryKeys={["word"]}
        selectedChildId="child-1"
      />,
    );

    const select = screen.getByLabelText("Chọn hồ sơ bé để xem dữ liệu");
    await userEvent.selectOptions(select, "child-2");

    const params = new URLSearchParams(
      (pushMock.mock.calls[0]![0] as string).split("?")[1],
    );

    expect(params.has("page")).toBe(false);
    expect(params.has("word")).toBe(false);
    expect(params.get("childId")).toBe("child-2");
  });
});
