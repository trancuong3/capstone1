import { computeUniversalPageWordLayout } from "@/lib/reading/ocr-text-reflow";
import type { ReadingPageDTO } from "@/types/reading";

export type DuetRole = "PARENT" | "CHILD";

export interface DuetTurnUI {
  readonly turnIndex: number;
  readonly role: DuetRole;
  readonly blockType: string;
  readonly wordIds: readonly string[];
  readonly startWordIndex: number;
  readonly endWordIndex: number;
  readonly text: string;
}

const DIALOGUE_MARKER_RE = /^\s*(?:[—–]|-\s+|“|"|«)/;

export function buildDuetTurnsForPage(page: ReadingPageDTO): DuetTurnUI[] {
  if (!page.words || page.words.length === 0) {
    return [];
  }

  // 1. Prefer server Studio V2 duet_segments when valid
  if (Array.isArray(page.duet_segments) && page.duet_segments.length >= 2) {
    const mapped: DuetTurnUI[] = [];
    for (const seg of page.duet_segments) {
      const validIdxs = seg.word_indices.filter(
        (idx: number) => idx >= 0 && idx < page.words.length,
      );
      if (validIdxs.length === 0) continue;
      const sortedIdxs = [...validIdxs].sort((a, b) => a - b);
      const wordIds = sortedIdxs.map((idx) => page.words[idx]!.word_id);
      mapped.push({
        turnIndex: mapped.length,
        role: seg.role === "CHILD" ? "CHILD" : "PARENT",
        blockType: seg.block_type || "STORY_BODY",
        wordIds,
        startWordIndex: sortedIdxs[0]!,
        endWordIndex: sortedIdxs[sortedIdxs.length - 1]!,
        text:
          seg.text || sortedIdxs.map((idx) => page.words[idx]!.text).join(" "),
      });
    }
    if (mapped.length >= 2) {
      return mapped;
    }
  }

  // 2. Client deterministic fallback using OCR reflow layout
  const { entries: layout } = computeUniversalPageWordLayout(page);
  const pageKind = (page.page_kind ?? "").toUpperCase();
  const rawGroups: { blockType: string; indices: number[] }[] = [];

  if (pageKind === "POEM" || pageKind === "COMIC") {
    const byLine = new Map<number, number[]>();
    const lineOrder: number[] = [];
    for (const entry of layout) {
      if (!byLine.has(entry.lineIndex)) {
        byLine.set(entry.lineIndex, []);
        lineOrder.push(entry.lineIndex);
      }
      byLine.get(entry.lineIndex)!.push(entry.index);
    }
    const step = pageKind === "POEM" && lineOrder.length >= 4 ? 2 : 1;
    for (let i = 0; i < lineOrder.length; i += step) {
      const chunkLines = lineOrder.slice(i, i + step);
      const idxs = chunkLines.flatMap((li) => byLine.get(li) ?? []);
      if (idxs.length > 0) {
        const text = idxs.map((idx) => page.words[idx]!.text).join(" ");
        rawGroups.push({
          blockType: DIALOGUE_MARKER_RE.test(text)
            ? "DIALOGUE"
            : pageKind === "POEM"
              ? "POEM_BODY"
              : "DIALOGUE",
          indices: idxs,
        });
      }
    }
  } else {
    let current: number[] = [];
    let currentType = "STORY_BODY";
    for (const entry of layout) {
      const startsNewLine = entry.breakCount > 0;
      const isDialogueStart =
        startsNewLine && DIALOGUE_MARKER_RE.test(entry.word.text);
      if (current.length > 0 && (entry.breakCount >= 2 || isDialogueStart)) {
        rawGroups.push({ blockType: currentType, indices: current });
        current = [];
        currentType = isDialogueStart ? "DIALOGUE" : "STORY_BODY";
      } else if (current.length === 0) {
        currentType = DIALOGUE_MARKER_RE.test(entry.word.text)
          ? "DIALOGUE"
          : "STORY_BODY";
      }
      current.push(entry.index);
      const cleanedEnd = entry.word.text.replace(/["'”’)»]+$/g, "");
      if (
        cleanedEnd.endsWith(".") ||
        cleanedEnd.endsWith("!") ||
        cleanedEnd.endsWith("?") ||
        cleanedEnd.endsWith("…")
      ) {
        if (current.length >= 4) {
          rawGroups.push({ blockType: currentType, indices: current });
          current = [];
          currentType = "STORY_BODY";
        }
      }
    }
    if (current.length > 0) {
      rawGroups.push({ blockType: currentType, indices: current });
    }
  }

  if (rawGroups.length === 1 && page.words.length >= 6) {
    const mid = Math.floor(page.words.length / 2);
    const all = rawGroups[0]!.indices;
    rawGroups.splice(
      0,
      1,
      { blockType: rawGroups[0]!.blockType, indices: all.slice(0, mid) },
      { blockType: rawGroups[0]!.blockType, indices: all.slice(mid) },
    );
  }

  return rawGroups.map((grp, idx) => ({
    turnIndex: idx,
    role: idx % 2 === 0 ? "PARENT" : "CHILD",
    blockType: grp.blockType,
    wordIds: grp.indices.map((i) => page.words[i]!.word_id),
    startWordIndex: grp.indices[0]!,
    endWordIndex: grp.indices[grp.indices.length - 1]!,
    text: grp.indices.map((i) => page.words[i]!.text).join(" "),
  }));
}

export function resolveActiveDuetTurn(
  turns: readonly DuetTurnUI[],
  currentWordId: string | null,
  completedWordIds: ReadonlySet<string>,
): DuetTurnUI | null {
  if (turns.length === 0) return null;
  if (currentWordId) {
    const containing = turns.find((turn) =>
      turn.wordIds.includes(currentWordId),
    );
    if (containing) return containing;
  }
  const firstIncomplete = turns.find((turn) =>
    turn.wordIds.some((id) => !completedWordIds.has(id)),
  );
  return firstIncomplete ?? turns[turns.length - 1] ?? null;
}
