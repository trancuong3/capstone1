import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
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

it("uses 640px side-by-side desk overrides, non-fullWidth desk-primary, and word-wrapping recent link", async () => {
  sessionService.list.mockResolvedValue({
    sessions: [{ ...session, state: "FINISHED" }],
  });
  const { container } = openDesk();
  const recentLink = await screen.findByRole("link", {
    name: /Lần đọc gần nhất/,
  });
  expect(recentLink.className).toContain("max-w-full");
  expect(recentLink.className).toContain("break-words");

  const deskSection = container.querySelector(".family-reading-desk");
  expect(deskSection?.className).toContain(
    "min-[640px]:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]!",
  );

  const chooseBtn = screen.getByRole("button", { name: "Chọn sách" });
  expect(chooseBtn.className).toContain("w-auto");
  expect(chooseBtn.className).not.toContain("w-full");
  expect(chooseBtn.className).toContain("min-h-11!");

  const illustration = container.querySelector(".desk-illustration");
  expect(illustration?.className).toContain("max-[640px]:max-h-[92px]!");
  expect(illustration?.className).toContain("min-[640px]:max-md:row-auto!");
  expect(illustration?.className).toContain(
    "min-[640px]:max-md:min-h-[200px]!",
  );
  expect(illustration?.className).toContain("min-[640px]:max-md:max-h-none!");
  expect(illustration?.className).not.toContain("md:min-h-[264px]!");
  expect(illustration?.className).not.toContain("min-[921px]:min-h-[324px]!");
  expect(container.innerHTML).not.toMatch(/\b(?:max-)?sm:/);
});
