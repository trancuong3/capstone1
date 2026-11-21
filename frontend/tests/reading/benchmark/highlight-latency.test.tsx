import { act, render } from "@testing-library/react";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { BookPageContent } from "@/components/reading/book-page-content";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";
import type { ReadingPageDTO } from "@/types/reading";

function makePage(wordCount: number): ReadingPageDTO {
  const sample = [
    "Bé",
    "tôi",
    "ăn",
    "cơm",
    "với",
    "cá",
    "kho",
    "ngon",
    "lắm.",
    "Mèo",
    "nhỏ",
    "ngủ",
  ];
  const words = Array.from({ length: wordCount }, (_, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text: sample[index % sample.length],
    bbox: [
      0.05 + (index % 8) * 0.11,
      0.1 + Math.floor(index / 8) * 0.06,
      0.09,
      0.04,
    ] as const,
    line_index: Math.floor(index / 8),
  }));
  return {
    page_id: "bench-page",
    page_revision_id: "bench-rev",
    page_number: 1,
    confidence: 0.98,
    width: 800,
    height: 1100,
    text: words.map((w) => w.text).join(" "),
    words,
  };
}

function previewAt(
  page: ReadingPageDTO,
  cursor: number,
): RealtimeAlignmentSnapshot {
  return {
    currentWordId: page.words[cursor]?.word_id ?? null,
    currentWordIndex: cursor,
    statusByWordId: new Map(),
    repeatedWordIds: new Set(),
    hesitationWordIds: new Set(),
    repeatedItems: [],
    hesitations: [],
    spokenWords: [],
    previewMatchedWordIds: new Set(
      page.words.slice(0, cursor).map((w) => w.word_id),
    ),
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

describe("highlight latency benchmark (120-word page, 30 streaming interim updates)", () => {
  it("measures p50/p95 DOM update latency from interim snapshot to highlighted word", () => {
    const page = makePage(120);
    const { container, rerender } = render(
      <BookPageContent
        page={page}
        currentWordId={page.words[0].word_id}
        previewSnapshot={null}
      />,
    );

    const latenciesMs: number[] = [];
    for (let step = 1; step <= 30; step += 1) {
      const snapshot = previewAt(page, step);
      const t0 = performance.now();
      act(() => {
        rerender(
          <BookPageContent
            page={page}
            currentWordId={page.words[0].word_id}
            previewSnapshot={snapshot}
          />,
        );
      });
      const active = container.querySelector('[aria-current="true"]');
      const elapsed = performance.now() - t0;
      expect(active?.getAttribute("data-word-id")).toBe(`w-${step}`);
      const prev = container.querySelector(`[data-word-id="w-${step - 1}"]`);
      expect(prev?.getAttribute("data-reading-state")).toBe("preview-correct");
      latenciesMs.push(elapsed);
    }

    const p50 = Number(percentile(latenciesMs, 50).toFixed(2));
    const p95 = Number(percentile(latenciesMs, 95).toFixed(2));
    console.log(
      JSON.stringify({
        benchmark: "highlight-latency",
        wordCount: 120,
        steps: 30,
        p50Ms: p50,
        p95Ms: p95,
      }),
    );
    expect(p95).toBeLessThan(200);
  });
});
