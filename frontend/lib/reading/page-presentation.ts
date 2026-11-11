import type { ReadingPageDTO } from "@/types/reading";

export interface ContainedImageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function containImage(
  width: number,
  height: number,
  frameWidth: number,
  frameHeight: number,
): ContainedImageRect | null {
  if (
    ![width, height, frameWidth, frameHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const scale = Math.min(frameWidth / width, frameHeight / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  return {
    left: (frameWidth - renderedWidth) / 2,
    top: (frameHeight - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
  };
}

export function hasTrustworthyWordBoxes(page: ReadingPageDTO): boolean {
  if (
    page.image_overlay_safe !== true ||
    !page.words.length ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  )
    return false;
  const identities = new Set<string>();
  const boxes = new Set<string>();
  return page.words.every((word, index) => {
    if (!Array.isArray(word.bbox) || word.bbox.length !== 4) return false;
    const [x, y, width, height] = word.bbox;
    const boxKey = word.bbox.join(":");
    if (
      !word.word_id.trim() ||
      !word.text.trim() ||
      identities.has(word.word_id) ||
      boxes.has(boxKey) ||
      !Number.isInteger(word.word_index) ||
      (index > 0 && word.word_index <= page.words[index - 1].word_index) ||
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1.000001 ||
      y + height > 1.000001
    )
      return false;
    identities.add(word.word_id);
    boxes.add(boxKey);
    return true;
  });
}

export function canOverlayPage(
  page: ReadingPageDTO,
  rect: ContainedImageRect | null,
  naturalWidth: number,
  naturalHeight: number,
): boolean {
  if (
    !rect ||
    !hasTrustworthyWordBoxes(page) ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  )
    return false;
  if (
    Math.abs(naturalWidth / naturalHeight / (page.width / page.height) - 1) >
    0.01
  )
    return false;
  // Dense or low-resolution sources use the OCR panel to keep large type.
  return page.words.every(
    (word) =>
      word.bbox[3] * rect.height >= 18 && word.bbox[3] * naturalHeight >= 10,
  );
}
