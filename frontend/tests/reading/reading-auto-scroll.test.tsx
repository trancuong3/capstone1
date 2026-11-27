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

  it("AUTO-RETRY-01: centers active misread words at lines 5, 50, 95 inside retry comfort band [22%, 54%] on a 105-line page without scrolling window", () => {
    const rafOriginal = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    try {
      // 105 lines x 3 words = 315 words (line index = Math.floor(idx / 3))
      const page = buildLongPage("p1", "rev1", 1, 315);
      const line5Word = page.words[4 * 3]; // line 5 (0-based 4)
      const line50Word = page.words[49 * 3]; // line 50 (0-based 49)
      const line95Word = page.words[94 * 3]; // line 95 (0-based 94)

      const { container, rerender } = render(
        <BookPageViewer page={page} currentWordId="p1-w-0" />,
      );
      const scrollEl = container.querySelector<HTMLElement>(
        '[data-reading-scroll-container="true"]',
      )!;
      const tops = new Map<string, number>();
      page.words.forEach((w) => tops.set(w.word_id, w.line_index! * 48));
      const geom = setupScrollGeometry(scrollEl, tops, {
        clientHeight: 400,
        scrollHeight: 5400,
      });

      // Enter retryMode on line 5 (4*48=192): inside [88, 216] only if bottom<=216 (192+44=236 > 216), so centers to 38% (152)
      rerender(
        <BookPageViewer
          page={page}
          currentWordId={line5Word.word_id}
          retryMode
          retryFocusKey={`0:${line5Word.word_id}:false:false:false`}
        />,
      );
      expect(geom.scrollToSpy).toHaveBeenCalledWith({
        top: 4 * 48 - 152,
        behavior: "smooth",
      });

      // Line 50 (49 * 48 = 2352, 38% of 400 = 152 -> top = 2200)
      geom.scrollToSpy.mockClear();
      rerender(
        <BookPageViewer
          page={page}
          currentWordId={line50Word.word_id}
          retryMode
          retryFocusKey={`1:${line50Word.word_id}:false:false:false`}
        />,
      );
      expect(geom.scrollToSpy).toHaveBeenCalledWith({
        top: 49 * 48 - 152,
        behavior: "smooth",
      });

      geom.scrollToSpy.mockClear();
      rerender(
        <BookPageViewer
          page={page}
          currentWordId={line95Word.word_id}
          retryMode
          retryFocusKey={`2:${line95Word.word_id}:false:false:false`}
        />,
      );
      expect(geom.scrollToSpy).toHaveBeenCalledWith({
        top: 94 * 48 - 152,
        behavior: "smooth",
      });
      expect(windowScrollSpy).not.toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = rafOriginal;
    }
  });

  it("AUTO-RETRY-02: dock resize does not false-detach, and entering retryMode from paused bottom resets auto-follow and scrolls to wrong word #1", () => {
    const rafOriginal = window.requestAnimationFrame;
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const OriginalRO = window.ResizeObserver;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.ResizeObserver = class FakeResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const page = buildLongPage("p1", "rev1", 1, 120);
      const { container, rerender } = render(
        <BookPageViewer page={page} currentWordId="p1-w-0" />,
      );
      const scrollEl = container.querySelector<HTMLElement>(
        '[data-reading-scroll-container="true"]',
      )!;
      const tops = new Map<string, number>();
      page.words.forEach((w, idx) => tops.set(w.word_id, idx * 48));
      let dynamicClientHeight = 500;
      let scrollTop = 0;
      const scrollToSpy = vi.fn((arg: ScrollToOptions | number, y?: number) => {
        const top = typeof arg === "number" ? (y ?? 0) : (arg.top ?? 0);
        scrollTop = Math.max(0, Math.min(6000 - dynamicClientHeight, top));
      });
      Object.defineProperty(scrollEl, "clientHeight", {
        configurable: true,
        get: () => dynamicClientHeight,
      });
      Object.defineProperty(scrollEl, "scrollHeight", {
        configurable: true,
        get: () => 6000,
      });
      Object.defineProperty(scrollEl, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = Math.max(0, Math.min(6000 - dynamicClientHeight, v));
        },
      });
      Object.defineProperty(scrollEl, "scrollTo", {
        configurable: true,
        value: scrollToSpy,
      });
      vi.spyOn(scrollEl, "getBoundingClientRect").mockImplementation(() =>
        DOMRect.fromRect({
          x: 0,
          y: 80,
          width: 600,
          height: dynamicClientHeight,
        }),
      );
      for (const [wordId, docTop] of tops.entries()) {
        const node = scrollEl.querySelector<HTMLElement>(
          `[data-word-id="${wordId}"]`,
        );
        if (!node) continue;
        vi.spyOn(node, "getBoundingClientRect").mockImplementation(() =>
          DOMRect.fromRect({
            x: 20,
            y: 80 + (docTop - scrollTop),
            width: 80,
            height: 40,
          }),
        );
      }

      // 1. User manually scrolls all the way to the bottom -> data-auto-follow="paused"
      now += 1500;
      act(() => {
        fireEvent.wheel(scrollEl, { deltaY: 3000 });
        scrollTop = 5500;
        fireEvent.scroll(scrollEl);
      });
      expect(scrollEl).toHaveAttribute("data-auto-follow", "paused");
      expect(screen.getByTestId("resume-auto-follow-btn")).toBeVisible();

      // 2. Dock expands -> container shrinks (500 -> 360) and fires a scroll event inside 260ms resize guard:
      // must NOT cause false detachment when already active, and entering retryMode must re-attach!
      dynamicClientHeight = 360;
      act(() => {
        for (const cb of resizeCallbacks) {
          cb([], {} as ResizeObserver);
        }
      });

      // 3. Enter retryMode pointing at wrong word #1 (p1-w-20 at docTop=960) without clicking "Về từ đang đọc"
      scrollToSpy.mockClear();
      rerender(
        <BookPageViewer
          page={page}
          currentWordId="p1-w-20"
          retryMode
          retryFocusKey="0:p1-w-20:false:false:false"
        />,
      );
      expect(scrollEl).toHaveAttribute("data-auto-follow", "active");
      expect(screen.queryByTestId("resume-auto-follow-btn")).toBeNull();
      expect(scrollToSpy).toHaveBeenCalledWith({
        top: 20 * 48 - Math.round(360 * 0.38 * 100) / 100,
        behavior: "smooth",
      });
    } finally {
      window.requestAnimationFrame = rafOriginal;
      window.ResizeObserver = OriginalRO;
    }
  });

  it("AUTO-RETRY-03: handles cross-page retry focus, mobile tap (<=8px touchmove) without detaching, and ILLUSTRATED image load re-center", () => {
    const rafOriginal = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    try {
      const page1 = buildLongPage("p1", "rev1", 1, 90);
      const page2 = buildLongPage("p2", "rev2", 2, 90);

      // Start on page 2 -> retry moves to page 1 bottom word (p1-w-85)
      const { container, rerender } = render(
        <BookPageViewer page={page2} currentWordId="p2-w-85" />,
      );
      rerender(
        <BookPageViewer
          page={page1}
          currentWordId="p1-w-85"
          retryMode
          retryFocusKey="0:p1-w-85:false:false:false"
        />,
      );
      const scrollEl1 = container.querySelector<HTMLElement>(
        '[data-reading-scroll-container="true"]',
      )!;
      expect(scrollEl1).toHaveAttribute("data-auto-follow", "active");

      // Simulate mobile tap (touchstart + 4px jitter + touchend) then late scroll tail -> must NOT detach!
      const tops1 = new Map<string, number>();
      page1.words.forEach((w, idx) => tops1.set(w.word_id, idx * 48));
      const geom1 = setupScrollGeometry(scrollEl1, tops1, {
        clientHeight: 400,
        scrollHeight: 4400,
      });
      now += 1500;
      act(() => {
        fireEvent.touchStart(scrollEl1, { touches: [{ clientY: 200 }] });
        fireEvent.touchMove(scrollEl1, { touches: [{ clientY: 204 }] });
        fireEvent.touchEnd(scrollEl1);
      });
      now += 1100;
      act(() => {
        geom1.setScrollTop(0);
        fireEvent.scroll(scrollEl1);
      });
      expect(scrollEl1).toHaveAttribute("data-auto-follow", "active");

      // Cross-page to page 2 bottom word
      rerender(
        <BookPageViewer
          page={page2}
          currentWordId="p2-w-85"
          retryMode
          retryFocusKey="1:p2-w-85:false:false:false"
        />,
      );
      expect(
        container.querySelector('[data-reading-scroll-container="true"]'),
      ).toHaveAttribute("data-auto-follow", "active");

      // Fresh ILLUSTRATED page: image onLoad bumps layoutRevision & re-centers active word
      const { container: illusContainer } = render(
        <BookPageViewer
          page={page1}
          currentWordId="p1-w-85"
          retryMode
          retryFocusKey="0:p1-w-85:false:false:false"
          illustrationUrl="https://example.com/art.png"
          illustrationTextFree
          initialReadingMode="ILLUSTRATED"
        />,
      );
      const scrollElIllus = illusContainer.querySelector<HTMLElement>(
        '[data-reading-scroll-container="true"]',
      )!;
      const illusTops = new Map<string, number>();
      page1.words.forEach((w, idx) => illusTops.set(w.word_id, idx * 48));
      const geomIllus = setupScrollGeometry(scrollElIllus, illusTops, {
        clientHeight: 400,
        scrollHeight: 4600,
      });
      const img = screen.getByAltText("Tranh minh họa trang 1");
      act(() => {
        fireEvent.load(img);
      });
      expect(scrollElIllus).toHaveAttribute("data-auto-follow", "active");
      expect(geomIllus.scrollToSpy).toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = rafOriginal;
    }
  });
});
