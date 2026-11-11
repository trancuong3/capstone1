import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import type { ReadingPageDTO } from "@/types/reading";

const page: ReadingPageDTO = {
  page_id: "33333333-3333-4333-8333-333333333333",
  page_revision_id: "44444444-4444-4444-8444-444444444444",
  page_number: 2,
  confidence: 0.99,
  width: 800,
  height: 1000,
  image_url: "https://example.test/scanned-page.png",
  text: "Mẹ đưa bé đến trường.",
  words: [],
};

describe("BookPageViewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const imagePage: ReadingPageDTO = {
    ...page,
    image_overlay_safe: true,
    width: 600,
    height: 800,
    words: ["Bé", "đọc"].map((text, index) => ({
      word_id: `word-${index}`,
      word_index: index,
      text,
      bbox: [0.1 + index * 0.35, 0.2, 0.3, 0.1] as const,
    })),
  };

  function loadImage(container: HTMLElement, width = 600, height = 800) {
    const probe = container.querySelector<HTMLImageElement>(
      "[data-page-image-probe]",
    )!;
    Object.defineProperties(probe, {
      naturalWidth: { value: width },
      naturalHeight: { value: height },
    });
    fireEvent.load(probe);
  }

  it("renders a real word overlay with letterboxing and keeps a single reading surface", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 900,
      height: 600,
    } as DOMRect);
    const { container } = render(
      <BookPageViewer page={imagePage} currentWordId="word-1" />,
    );
    loadImage(container);
    await waitFor(() =>
      expect(screen.getByLabelText("Trang sách 2")).toHaveAttribute(
        "data-render-mode",
        "image-overlay",
      ),
    );
    const overlay = container.querySelector("[data-image-overlay]");
    const frameHeight = Math.min(window.innerHeight * 0.6, 680);
    expect(overlay).toHaveStyle({
      left: `${(900 - frameHeight * 0.75) / 2}px`,
      top: "0px",
      width: `${frameHeight * 0.75}px`,
      height: `${frameHeight}px`,
    });
    expect(
      parseFloat(screen.getByRole("button", { name: "đọc" }).style.left),
    ).toBeCloseTo(45, 5);
    expect(screen.getByRole("button", { name: "đọc" })).toHaveStyle({
      top: "20%",
    });
    expect(screen.getByRole("button", { name: "đọc" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(container.querySelector('[data-reading-panel="text"]')).toBeNull();
  });

  it.each(["broken", "ratio-mismatch", "bad-bbox"])(
    "keeps readable text and removes unsafe overlays for %s",
    async (scenario) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 900,
        height: 600,
      } as DOMRect);
      const selected =
        scenario === "bad-bbox"
          ? {
              ...imagePage,
              words: [{ ...imagePage.words[0], bbox: [0, 0, 0, 0] as const }],
            }
          : imagePage;
      const { container } = render(
        <BookPageViewer page={selected} currentWordId="word-0" />,
      );
      if (scenario === "broken")
        fireEvent.error(container.querySelector("[data-page-image-probe]")!);
      else
        loadImage(container, scenario === "ratio-mismatch" ? 1200 : 600, 800);
      await waitFor(() =>
        expect(screen.getByLabelText("Trang sách 2")).toHaveAttribute(
          "data-image-status",
          scenario === "broken" ? "failed" : "loaded",
        ),
      );
      expect(container.querySelector("[data-image-overlay]")).toBeNull();
      expect(screen.getByRole("button", { name: "Bé" })).toBeInTheDocument();
      expect(
        container.querySelector('[data-reading-panel="text"]'),
      ).not.toBeNull();
    },
  );

  it.each([undefined, false])(
    "keeps word identities, current word and initial errors in text fallback for geometry proof %s",
    async (image_overlay_safe) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 900,
        height: 600,
      } as DOMRect);
      const initialErrors = new Set(["word-1"]);
      const selected = { ...imagePage, image_overlay_safe };
      const { container } = render(
        <BookPageViewer
          page={selected}
          currentWordId="word-1"
          mispronouncedWordIds={initialErrors}
        />,
      );
      loadImage(container);
      await waitFor(() =>
        expect(screen.getByLabelText("Trang sách 2")).toHaveAttribute(
          "data-render-mode",
          "image-reference",
        ),
      );
      expect(container.querySelector("[data-image-overlay]")).toBeNull();
      const word = screen.getByRole("button", { name: "đọc" });
      expect(word).toHaveAttribute("data-word-id", "word-1");
      expect(word).toHaveAttribute("aria-current", "true");
      expect(word).toHaveAttribute("data-reading-state", "incorrect");
      expect(initialErrors).toEqual(new Set(["word-1"]));
      expect(selected.words).toEqual(imagePage.words);
    },
  );

  it("shows self-corrected and unresolved words distinctly without changing first-pass sets", () => {
    const initialErrors = new Set(["word-0", "word-1"]);
    render(
      <BookPageViewer
        page={{ ...imagePage, image_url: null }}
        currentWordId={null}
        mispronouncedWordIds={initialErrors}
        selfCorrectedWordIds={new Set(["word-0"])}
        unresolvedWordIds={new Set(["word-1"])}
      />,
    );
    expect(screen.getByRole("button", { name: "Bé" })).toHaveAttribute(
      "data-reading-state",
      "self-corrected",
    );
    expect(
      screen.getByRole("button", { name: "Bé" }),
    ).toHaveAccessibleDescription("Bé đã tự sửa đúng");
    expect(screen.getByRole("button", { name: "đọc" })).toHaveAttribute(
      "data-reading-state",
      "unresolved",
    );
    expect(initialErrors).toEqual(new Set(["word-0", "word-1"]));
  });
  it("preserves OCR line breaks and paragraph indentation while rendering words", () => {
    const formattedPage: ReadingPageDTO = {
      ...page,
      text: "Ngày xưa\ncó\n\n    một cậu\nbé",
      paragraph_start_line_indices: [2],
      indented_line_indices: [2],
      words: [
        {
          word_id: "11111111-1111-4111-8111-111111111111",
          word_index: 0,
          line_index: 0,
          text: "Ngày",
          bbox: [0.1, 0.1, 0.05, 0.02],
        },
        {
          word_id: "22222222-2222-4222-8222-222222222222",
          word_index: 1,
          line_index: 0,
          text: "xưa",
          bbox: [0.16, 0.1, 0.05, 0.02],
        },
        {
          word_id: "33333333-3333-4333-8333-333333333333",
          word_index: 2,
          line_index: 1,
          text: "có",
          bbox: [0.1, 0.15, 0.03, 0.02],
        },
        {
          word_id: "44444444-4444-4444-8444-444444444444",
          word_index: 3,
          line_index: 2,
          text: "một",
          bbox: [0.13, 0.23, 0.04, 0.02],
        },
        {
          word_id: "55555555-5555-4555-8555-555555555555",
          word_index: 4,
          line_index: 2,
          text: "cậu",
          bbox: [0.18, 0.23, 0.04, 0.02],
        },
        {
          word_id: "66666666-6666-4666-8666-666666666666",
          word_index: 5,
          line_index: 3,
          text: "bé",
          bbox: [0.1, 0.28, 0.03, 0.02],
        },
      ],
    };
    const { container } = render(
      <BookPageViewer currentWordId={null} page={formattedPage} />,
    );

    expect(screen.getByRole("button", { name: "Ngày" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "một" })).toBeInTheDocument();
    expect(container.querySelectorAll("br")).toHaveLength(4);
    expect(
      container.querySelector(
        '[data-word-id="44444444-4444-4444-8444-444444444444"]',
      ),
    ).toHaveAttribute("data-line-index", "2");
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(
      1,
    );
  });

  it("keeps OCR text readable and offers the source image as an optional reference", () => {
    render(<BookPageViewer currentWordId={null} page={page} />);

    expect(screen.getByText("Mẹ đưa bé đến trường.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Trang sách của bé")).toBeInTheDocument();
    expect(screen.getByText("Xem ảnh trang sách")).toBeInTheDocument();
  });
});
