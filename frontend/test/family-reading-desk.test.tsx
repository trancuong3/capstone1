import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FamilyReadingDesk } from "@/components/dashboard/family-reading-desk";

const sessionService = vi.hoisted(() => ({ list: vi.fn(), getBook: vi.fn() }));
vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: () => ({ sessionService }),
}));
vi.mock("@/lib/api/family-pedagogy-service", () => ({
  createFamilyPedagogyService: () => ({
    getReadingPassport: vi.fn().mockResolvedValue({
      child_id: "child-a",
      unlocked_stamps_count: 1,
      total_stamps_count: 4,
      streak_days: 2,
      gentle_message_vi: "Bé đang đọc đều đặn mỗi ngày.",
      stamps: [],
    }),
    getEncouragementNote: vi.fn().mockResolvedValue(null),
  }),
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

it("keeps recent unfinished sessions within 12 hours resumable", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  sessionService.list.mockResolvedValue({
    sessions: [{ ...session, state: "PAUSED", started_at: twoHoursAgo }],
  });
  openDesk();
  expect(await screen.findByRole("link", { name: "Đọc tiếp" })).toHaveAttribute(
    "href",
    "/reading/reading-a",
  );
});

it("treats stale unfinished sessions older than 12 hours as non-resumable", async () => {
  const thirteenHoursAgo = new Date(
    Date.now() - 13 * 60 * 60 * 1000,
  ).toISOString();
  sessionService.list.mockResolvedValue({
    sessions: [{ ...session, state: "PAUSED", started_at: thirteenHoursAgo }],
  });
  openDesk();
  expect(
    await screen.findByRole("link", { name: /Lần đọc gần nhất/ }),
  ).toHaveAttribute("href", "/sessions/reading-a?childId=child-a");
  expect(screen.queryByRole("link", { name: "Đọc tiếp" })).toBeNull();
});

it("keeps the 5-minute train CTA outside the narrow desk hero and expands passport tab to full width", async () => {
  sessionService.list.mockResolvedValue({ sessions: [] });
  const { container } = openDesk();

  expect(screen.queryByTestId("five-minute-train-cta-card")).toBeNull();
  const desk = container.querySelector(".family-reading-desk");
  expect(desk).not.toHaveClass("family-reading-desk--passport");
  expect(container.querySelector(".desk-illustration")).not.toBeNull();

  fireEvent.click(screen.getByTestId("desk-tab-passport"));
  expect(await screen.findByTestId("reading-passport-panel")).toBeVisible();
  expect(desk).toHaveClass("family-reading-desk--passport");
  expect(container.querySelector(".desk-illustration")).toBeNull();

  fireEvent.click(screen.getByTestId("desk-tab-bookshelf"));
  expect(desk).not.toHaveClass("family-reading-desk--passport");
  expect(container.querySelector(".desk-illustration")).not.toBeNull();
});
