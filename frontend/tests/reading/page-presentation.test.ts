import { describe, expect, it } from "vitest";
import {
  canOverlayPage,
  containImage,
  hasTrustworthyWordBoxes,
} from "@/lib/reading/page-presentation";
import type { ReadingPageDTO } from "@/types/reading";

const page: ReadingPageDTO = {
  page_id: "page-1",
  page_revision_id: "revision-1",
  page_number: 1,
  width: 600,
  height: 800,
  confidence: null,
  image_url: "https://example.test/source.png",
  image_overlay_safe: true,
  words: [
    {
      word_id: "word-1",
      word_index: 0,
      text: "đọc",
      bbox: [0.1, 0.2, 0.3, 0.1],
    },
  ],
};

describe("multimodal reading geometry", () => {
  it("uses text for legacy or explicitly untrusted geometry even with valid normalized boxes", () => {
    for (const image_overlay_safe of [undefined, false]) {
      const legacy = { ...page, image_overlay_safe };
      expect(hasTrustworthyWordBoxes(legacy)).toBe(false);
      expect(
        canOverlayPage(legacy, containImage(600, 800, 900, 600), 600, 800),
      ).toBe(false);
    }
  });
  it("maps a portrait image into a landscape frame including horizontal letterboxing", () => {
    const rect = containImage(600, 800, 1000, 600);
    expect(rect).toEqual({ left: 275, top: 0, width: 450, height: 600 });
    expect(rect!.left + page.words[0].bbox[0] * rect!.width).toBe(320);
    expect(rect!.top + page.words[0].bbox[1] * rect!.height).toBe(120);
  });
  it("maps a landscape image into a portrait frame including vertical letterboxing", () => {
    expect(containImage(1200, 600, 360, 600)).toEqual({
      left: 0,
      top: 210,
      width: 360,
      height: 180,
    });
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid image/frame dimensions %s",
    (value) => {
      expect(containImage(value, 800, 600, 600)).toBeNull();
      expect(containImage(600, 800, value, 600)).toBeNull();
      expect(
        canOverlayPage(page, containImage(600, 800, 600, 600), value, 800),
      ).toBe(false);
    },
  );
  it("uses overlay only when source ratio and displayed/source text size are readable", () => {
    expect(
      canOverlayPage(page, containImage(600, 800, 900, 600), 600, 800),
    ).toBe(true);
    expect(
      canOverlayPage(page, containImage(600, 800, 100, 100), 600, 800),
    ).toBe(false);
    expect(
      canOverlayPage(page, containImage(600, 800, 900, 600), 800, 600),
    ).toBe(false);
    expect(canOverlayPage(page, containImage(600, 800, 900, 600), 30, 40)).toBe(
      false,
    );
  });
  it.each(
    [
      [0, 0, 0, 0],
      [-0.1, 0, 0.2, 0.2],
      [0.9, 0, 0.2, 0.2],
      [0, 0.9, 0.2, 0.2],
      [0, 0, Number.NaN, 0.2],
    ].map((bbox) => ({ bbox })),
  )("falls back for invalid boxes $bbox", ({ bbox }) => {
    expect(
      hasTrustworthyWordBoxes({
        ...page,
        words: [
          { ...page.words[0], bbox: bbox as [number, number, number, number] },
        ],
      }),
    ).toBe(false);
  });
  it("rejects duplicated identities, duplicated boxes and reordered word indexes", () => {
    expect(
      hasTrustworthyWordBoxes({
        ...page,
        words: [
          page.words[0],
          { ...page.words[0], word_index: 1, bbox: [0.5, 0.2, 0.2, 0.1] },
        ],
      }),
    ).toBe(false);
    expect(
      hasTrustworthyWordBoxes({
        ...page,
        words: [
          page.words[0],
          { ...page.words[0], word_id: "word-2", word_index: 1 },
        ],
      }),
    ).toBe(false);
    expect(
      hasTrustworthyWordBoxes({
        ...page,
        words: [
          page.words[0],
          { ...page.words[0], word_id: "word-2", bbox: [0.5, 0.2, 0.2, 0.1] },
        ],
      }),
    ).toBe(false);
    expect(hasTrustworthyWordBoxes({ ...page, words: [] })).toBe(false);
  });
});
