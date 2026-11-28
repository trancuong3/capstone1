import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyReadingDesk } from "@/components/dashboard/family-reading-desk";

const sessionService = vi.hoisted(() => ({ list: vi.fn(), getBook: vi.fn() }));
vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: () => ({ sessionService }),
}));

const child = { id: "child-a", alias: "Bé An" };
const session = {
  id: "reading-a",
  child_id: child.id,
  book_id: "book-a",
  ended_at: null,
};
function openDesk() {
  return render(
    <FamilyReadingDesk child={child} hasProfiles onChooseBook={() => {}} />,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionService.getBook.mockResolvedValue({
    id: session.book_id,
    title: "Chú Mèo Nhỏ",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("opens the selected child's unfinished session", async () => {
  sessionService.list.mockResolvedValue({
    sessions: [{ ...session, state: "PAUSED" }],
  });
  openDesk();
  expect(await screen.findByRole("link", { name: "Đọc tiếp" })).toHaveAttribute(
    "href",
    "/reading/reading-a",
  );
});

it.each(["ABORTED", "FINISHED"])(
  "opens history for a %s session",
  async (state) => {
    sessionService.list.mockResolvedValue({
      sessions: [{ ...session, state }],
    });
    openDesk();
    expect(
      await screen.findByRole("link", { name: /Lần đọc gần nhất/ }),
    ).toHaveAttribute("href", "/sessions/reading-a?childId=child-a");
    expect(screen.getByRole("button", { name: "Chọn sách" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Đọc tiếp" })).toBeNull();
  },
);

describe("mobile viewport (< 768px)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: () => true,
      })),
    );
  });

  it("renders mobile reading hero with >=44px touch targets for recent and resumable states", async () => {
    sessionService.list.mockResolvedValue({
      sessions: [{ ...session, state: "FINISHED" }],
    });
    const { container, rerender } = openDesk();

    const recentLink = await screen.findByRole("link", {
      name: /Lần đọc gần nhất/,
    });
    expect(recentLink.className).toContain("min-h-11");
    expect(container.querySelector(".desk-illustration")).toBeNull();

    sessionService.list.mockResolvedValue({
      sessions: [{ ...session, state: "PAUSED" }],
    });
    rerender(
      <FamilyReadingDesk
        key="paused"
        child={child}
        hasProfiles
        onChooseBook={() => {}}
      />,
    );
    const resumeLink = await screen.findByRole("link", { name: "Đọc tiếp" });
    expect(resumeLink.className).toContain("min-h-12");
    expect(
      screen.getByRole("button", { name: "Chọn sách" }).className,
    ).toContain("min-h-11");
  });
});
