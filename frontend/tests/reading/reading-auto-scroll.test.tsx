import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import type { ReadingPageDTO } from "@/types/reading";

function buildLongPage(
  pageId: string,
  revisionId: string,
  pageNumber: number,
  wordCount = 60,
): ReadingPageDTO {
  const words = Array.from({ length: wordCount }, (_, index) => ({
    word_id: `${pageId}-w-${index}`,
    word_index: index,
    line_index: Math.floor(index / 3),
    text: `Từ${index + 1}`,
    bbox: [
      0.1 + (index % 3) * 0.2,
      0.05 + Math.floor(index / 3) * 0.04,
      0.15,
      0.03,
    ] as const,
  }));
  return {
    page_id: pageId,
    page_revision_id: revisionId,
    page_number: pageNumber,
    confidence: 0.99,
    width: 800,
    height: 1200,
    image_url: null,
    text: words.map((w) => w.text).join(" "),
    words,
  };
}

function setupScrollGeometry(
  container: HTMLElement,
  wordTopById: Map<string, number>,
  options: { clientHeight?: number; scrollHeight?: number } = {},
) {
  const clientHeight = options.clientHeight ?? 400;
  const scrollHeight = options.scrollHeight ?? 3000;
  let scrollTop = 0;

  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(container, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, value));
    },
  });

  const scrollToSpy = vi.fn((arg: ScrollToOptions | number, y?: number) => {
    const top = typeof arg === "number" ? (y ?? 0) : (arg.top ?? 0);
    scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, top));
  });
  Object.defineProperty(container, "scrollTo", {
    configurable: true,
    value: scrollToSpy,
  });

  vi.spyOn(container, "getBoundingClientRect").mockImplementation(() =>
    DOMRect.fromRect({ x: 0, y: 100, width: 600, height: clientHeight }),
  );

  for (const [wordId, docTop] of wordTopById.entries()) {
    const node = container.querySelector<HTMLElement>(
      `[data-word-id="${wordId}"]`,
    );
    if (!node) continue;
    vi.spyOn(node, "getBoundingClientRect").mockImplementation(() =>
      DOMRect.fromRect({
        x: 20,
        y: 100 + (docTop - scrollTop),
        width: 80,
        height: 44,
      }),
    );
  }

  return {
    scrollToSpy,
    getScrollTop: () => scrollTop,
    setScrollTop: (value: number) => {
      scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, value));
    },
  };
}

describe("useReadingAutoScroll (BookPageViewer container-scoped scroll)", () => {
  let windowScrollSpy: ReturnType<typeof vi.spyOn>;
  let now = 1000;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    windowScrollSpy = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => undefined);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls only the reading container (never window) when activeWordId leaves the comfort band", () => {
    const page = buildLongPage("p1", "rev1", 1, 40);
    const { container, rerender } = render(
      <BookPageViewer page={page} currentWordId="p1-w-0" />,
    );
    const scrollEl = container.querySelector<HTMLElement>(
      '[data-reading-scroll-container="true"]',
    )!;
    expect(scrollEl).not.toBeNull();

    const tops = new Map<string, number>();
    page.words.forEach((w, idx) => tops.set(w.word_id, idx * 60));
    const geom = setupScrollGeometry(scrollEl, tops, {
      clientHeight: 400,
      scrollHeight: 2600,
    });

    // Word 2 is at y=120 (bottom=164) inside [64, 240] -> no scroll needed
    rerender(<BookPageViewer page={page} currentWordId="p1-w-2" />);
    expect(geom.scrollToSpy).not.toHaveBeenCalled();

    // Word 4 is at y=240 (bottom=284 > 60% = 240) -> scrolls early to keep upcoming lines visible!
    rerender(<BookPageViewer page={page} currentWordId="p1-w-4" />);
    expect(geom.scrollToSpy).toHaveBeenCalledWith({
      top: 4 * 60 - 104,
      behavior: "smooth",
    });

    geom.scrollToSpy.mockClear();

    // Word 15 is at y=900 (outside [64, 240]) -> container scrolls smoothly to ~796 (26% from top)
    rerender(<BookPageViewer page={page} currentWordId="p1-w-15" />);
    expect(geom.scrollToSpy).toHaveBeenCalledWith({
      top: 15 * 60 - 104,
      behavior: "smooth",
    });
    expect(windowScrollSpy).not.toHaveBeenCalled();
  });

  it("pauses auto-follow on manual user scroll and never hijacks on subsequent word changes until resumed", () => {
    const page = buildLongPage("p1", "rev1", 1, 40);
    const { container, rerender } = render(
      <BookPageViewer page={page} currentWordId="p1-w-15" />,
    );
    const scrollEl = container.querySelector<HTMLElement>(
      '[data-reading-scroll-container="true"]',
    )!;
    const tops = new Map<string, number>();
    page.words.forEach((w, idx) => tops.set(w.word_id, idx * 60));
    const geom = setupScrollGeometry(scrollEl, tops, {
      clientHeight: 400,
      scrollHeight: 2600,
    });

    // Advance past any initial mount window, then simulate user scrolling back up to line 1
    now += 1500;
    act(() => {
      fireEvent.wheel(scrollEl, { deltaY: -400 });
      geom.setScrollTop(0);
      fireEvent.scroll(scrollEl);
    });

    expect(scrollEl).toHaveAttribute("data-auto-follow", "paused");
    const resumeBtn = screen.getByTestId("resume-auto-follow-btn");
    expect(resumeBtn).toBeVisible();

    geom.scrollToSpy.mockClear();

    // Active word advances from w-15 -> w-16 -> w-17 while detached: MUST NOT hijack scroll
    rerender(<BookPageViewer page={page} currentWordId="p1-w-16" />);
    rerender(<BookPageViewer page={page} currentWordId="p1-w-17" />);
    expect(geom.scrollToSpy).not.toHaveBeenCalled();
    expect(geom.getScrollTop()).toBe(0);

    // Clicking "Về từ đang đọc" re-attaches and scrolls back to active word
    act(() => {
      fireEvent.click(resumeBtn);
    });
    expect(scrollEl).toHaveAttribute("data-auto-follow", "active");
    expect(geom.scrollToSpy).toHaveBeenCalledWith({
      top: 17 * 60 - 104,
      behavior: "smooth",
    });
    expect(screen.queryByTestId("resume-auto-follow-btn")).toBeNull();
  });

  it("never falsely detaches on clicking a word inside the text area or on a late programmatic scroll tail", () => {
    const page = buildLongPage("p1", "rev1", 1, 40);
    const { container, rerender } = render(
      <BookPageViewer page={page} currentWordId="p1-w-0" />,
    );
    const scrollEl = container.querySelector<HTMLElement>(
      '[data-reading-scroll-container="true"]',
    )!;
    Object.defineProperty(scrollEl, "clientWidth", {
      configurable: true,
      get: () => 584,
    });
    const tops = new Map<string, number>();
    page.words.forEach((w, idx) => tops.set(w.word_id, idx * 60));
    const geom = setupScrollGeometry(scrollEl, tops, {
      clientHeight: 400,
      scrollHeight: 2600,
    });

    // Advance active word -> triggers smooth scroll
    rerender(<BookPageViewer page={page} currentWordId="p1-w-10" />);
    expect(geom.scrollToSpy).toHaveBeenCalledOnce();

    // Tapping a word inside clientWidth (clientX = 120 <= 584) MUST NOT mark scroll intent
    act(() => {
      fireEvent.pointerDown(scrollEl, { clientX: 120, clientY: 160 });
    });

    // Even if a smooth scroll tail arrives 1100ms later, auto-follow MUST stay active!
    now += 1100;
    act(() => {
      geom.setScrollTop(0);
      fireEvent.scroll(scrollEl);
    });
    expect(scrollEl).toHaveAttribute("data-auto-follow", "active");
    expect(screen.queryByTestId("resume-auto-follow-btn")).toBeNull();

    // Advancing to word 20 still auto-scrolls smoothly!
    geom.scrollToSpy.mockClear();
    rerender(<BookPageViewer page={page} currentWordId="p1-w-20" />);
    expect(geom.scrollToSpy).toHaveBeenCalledWith({
      top: 20 * 60 - 104,
      behavior: "smooth",
    });
  });

  it("uses instant scroll behavior when prefers-reduced-motion: reduce is set", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    const page = buildLongPage("p1", "rev1", 1, 30);
    const { container, rerender } = render(
      <BookPageViewer page={page} currentWordId="p1-w-0" />,
    );
    const scrollEl = container.querySelector<HTMLElement>(
      '[data-reading-scroll-container="true"]',
    )!;
    const tops = new Map<string, number>();
    page.words.forEach((w, idx) => tops.set(w.word_id, idx * 60));
    const geom = setupScrollGeometry(scrollEl, tops, {
      clientHeight: 400,
      scrollHeight: 2000,
    });

    rerender(<BookPageViewer page={page} currentWordId="p1-w-12" />);
    expect(geom.scrollToSpy).toHaveBeenCalledWith({
      top: 12 * 60 - 104,
      behavior: "instant",
    });
  });

  it("resets scrollTop to 0 and clears paused auto-follow on page change", () => {
    const page1 = buildLongPage("p1", "rev1", 1, 30);
    const page2 = buildLongPage("p2", "rev2", 2, 30);
    const { container, rerender } = render(
      <BookPageViewer page={page1} currentWordId="p1-w-15" />,
    );
    const scrollEl1 = container.querySelector<HTMLElement>(
      '[data-reading-scroll-container="true"]',
    )!;
    const tops1 = new Map<string, number>();
    page1.words.forEach((w, idx) => tops1.set(w.word_id, idx * 60));
    const geom1 = setupScrollGeometry(scrollEl1, tops1);

    now += 1500;
    act(() => {
      fireEvent.wheel(scrollEl1, { deltaY: -300 });
      geom1.setScrollTop(0);
      fireEvent.scroll(scrollEl1);
    });
    expect(scrollEl1).toHaveAttribute("data-auto-follow", "paused");

    // Navigate to page 2 -> resets scroll to top and re-attaches auto-follow
    rerender(<BookPageViewer page={page2} currentWordId="p2-w-0" />);
    const scrollEl2 = container.querySelector<HTMLElement>(
      '[data-reading-scroll-container="true"]',
    )!;
    expect(scrollEl2).toHaveAttribute("data-auto-follow", "active");
    expect(scrollEl2.scrollTop).toBe(0);
    expect(screen.queryByTestId("resume-auto-follow-btn")).toBeNull();
  });
});
