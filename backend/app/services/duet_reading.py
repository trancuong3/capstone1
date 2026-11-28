"""Studio V2 Duet / Turn-Taking Shared Reading segment builder.

Maps `PageOcrExtraction` (`PageKind` + `BlocksJson`) onto `ReadingPageWordDTO`
indices so Parent ("PARENT") and Child ("CHILD") can alternate lines, stanzas,
or comic/dialogue turns, with a deterministic line/sentence fallback for pages
without a Studio V2 extraction row.
"""
from __future__ import annotations

import re
from typing import Any

from app.schemas.reading import ReadingDuetSegmentDTO, ReadingPageWordDTO

_DIALOGUE_LINE_RE = re.compile(r"^\s*(?:[—–]|-\s+|“|\"|«)")
_SKIPPED_BLOCK_TYPES = frozenset(
    {
        "PAGE_NUMBER",
        "RUNNING_HEADER",
        "PUBLISHER_META",
        "BOOK_SERIES_TAG",
        "SECTION_BADGE",
        "WATERMARK_OR_STAMP",
        "NOISE_OCR",
    }
)


def _role_for_turn(index: int, *, block_type: str, prev_role: str | None) -> str:
    if block_type == "DIALOGUE" and prev_role == "PARENT":
        return "CHILD"
    if prev_role == "PARENT":
        return "CHILD"
    if prev_role == "CHILD":
        return "PARENT"
    return "PARENT" if index % 2 == 0 else "CHILD"


def build_duet_segments_for_page(
    words: list[ReadingPageWordDTO],
    *,
    page_kind: str | None = None,
    blocks_json: list[dict[str, Any]] | None = None,
    paragraph_start_line_indices: list[int] | None = None,
) -> list[ReadingDuetSegmentDTO]:
    """Build ordered Parent/Child duet reading turns covering `words`."""
    if not words:
        return []

    total_words = len(words)
    segments: list[ReadingDuetSegmentDTO] = []

    # 1. Studio V2 BlocksJson path when valid canonical blocks map to word indices
    if isinstance(blocks_json, list) and blocks_json:
        kept_blocks = [
            blk
            for blk in blocks_json
            if isinstance(blk, dict)
            and blk.get("decision", "KEEP") != "EXCLUDE"
            and blk.get("in_canonical", True) is not False
            and str(blk.get("block_type") or "STORY_BODY") not in _SKIPPED_BLOCK_TYPES
        ]
        kept_blocks.sort(key=lambda b: int(b.get("reading_order", 0) or 0))
        assigned_indices: set[int] = set()
        prev_role: str | None = None
        raw_block_turns: list[tuple[str, list[int]]] = []

        for blk in kept_blocks:
            block_type = str(blk.get("block_type") or "STORY_BODY")
            src_indices = blk.get("source_word_indices")
            valid_word_idxs: list[int] = []
            if isinstance(src_indices, list) and src_indices:
                for raw_idx in src_indices:
                    if (
                        isinstance(raw_idx, int)
                        and not isinstance(raw_idx, bool)
                        and 0 <= raw_idx < total_words
                        and raw_idx not in assigned_indices
                    ):
                        valid_word_idxs.append(raw_idx)
            if not valid_word_idxs:
                line_idxs = blk.get("line_indices")
                if isinstance(line_idxs, list) and line_idxs:
                    line_set = {
                        li
                        for li in line_idxs
                        if isinstance(li, int) and not isinstance(li, bool)
                    }
                    valid_word_idxs = [
                        idx
                        for idx, w in enumerate(words)
                        if w.line_index in line_set and idx not in assigned_indices
                    ]
            if not valid_word_idxs:
                continue
            valid_word_idxs.sort()
            assigned_indices.update(valid_word_idxs)
            raw_block_turns.append((block_type, valid_word_idxs))

        # Only use Studio V2 block turns directly if there are >= 2 turns and high coverage;
        # if a whole page is a single STORY_BODY/POEM_BODY block, split it into finer duet turns below.
        if len(raw_block_turns) >= 2 and len(assigned_indices) >= max(1, int(total_words * 0.7)):
            for turn_idx, (block_type, word_idxs) in enumerate(raw_block_turns):
                role = _role_for_turn(turn_idx, block_type=block_type, prev_role=prev_role)
                prev_role = role
                line_idxs = sorted({words[i].line_index for i in word_idxs})
                text = " ".join(words[i].text for i in word_idxs).strip()
                if text:
                    segments.append(
                        ReadingDuetSegmentDTO(
                            turn_index=len(segments),
                            role=role,  # type: ignore[arg-type]
                            block_type=block_type,
                            line_indices=line_idxs,
                            word_indices=word_idxs,
                            text=text,
                        )
                    )
            if segments:
                return segments

    # 2. Deterministic line/sentence/stanza fallback (covers 100% of catalog & private pages)
    by_line: dict[int, list[int]] = {}
    line_order: list[int] = []
    for idx, word in enumerate(words):
        li = int(word.line_index)
        if li not in by_line:
            by_line[li] = []
            line_order.append(li)
        by_line[li].append(idx)

    para_starts = set(paragraph_start_line_indices or [])
    normalized_kind = (page_kind or "").strip().upper()
    grouped_word_runs: list[tuple[str, list[int]]] = []

    if normalized_kind in {"POEM", "COMIC"} and len(line_order) >= 2:
        default_btype = "POEM_BODY" if normalized_kind == "POEM" else "DIALOGUE"
        # For poems > 4 lines, pair 2 lines per turn; otherwise 1 line per turn.
        step = 2 if normalized_kind == "POEM" and len(line_order) >= 4 else 1
        for pos in range(0, len(line_order), step):
            chunk_lines = line_order[pos : pos + step]
            idxs = [i for li in chunk_lines for i in by_line[li]]
            line_text = " ".join(words[i].text for i in idxs)
            btype = "DIALOGUE" if _DIALOGUE_LINE_RE.match(line_text) else default_btype
            grouped_word_runs.append((btype, idxs))
    else:
        current_idxs: list[int] = []
        current_btype = "STORY_BODY"
        for li in line_order:
            line_idxs = by_line[li]
            line_text = " ".join(words[i].text for i in line_idxs).strip()
            is_dialogue_line = bool(_DIALOGUE_LINE_RE.match(line_text))
            starts_new_para = li in para_starts or is_dialogue_line

            if current_idxs and starts_new_para:
                grouped_word_runs.append((current_btype, current_idxs))
                current_idxs = []
                current_btype = "DIALOGUE" if is_dialogue_line else "STORY_BODY"
            elif not current_idxs:
                current_btype = "DIALOGUE" if is_dialogue_line else "STORY_BODY"

            for w_idx in line_idxs:
                current_idxs.append(w_idx)
                token = words[w_idx].text.rstrip("\"'”’)»")
                if token.endswith((".", "!", "?", "…")) and len(current_idxs) >= 4:
                    grouped_word_runs.append((current_btype, current_idxs))
                    current_idxs = []
                    current_btype = "STORY_BODY"

        if current_idxs:
            grouped_word_runs.append((current_btype, current_idxs))

    # If still only 1 group and >= 6 words, split evenly at midpoint so parent & child both get a turn
    if len(grouped_word_runs) == 1 and total_words >= 6:
        only_btype, all_idxs = grouped_word_runs[0]
        mid = total_words // 2
        grouped_word_runs = [
            (only_btype, all_idxs[:mid]),
            (only_btype, all_idxs[mid:]),
        ]

    prev_role = None
    for turn_idx, (block_type, word_idxs) in enumerate(grouped_word_runs):
        if not word_idxs:
            continue
        role = _role_for_turn(turn_idx, block_type=block_type, prev_role=prev_role)
        prev_role = role
        line_idxs = sorted({words[i].line_index for i in word_idxs})
        text = " ".join(words[i].text for i in word_idxs).strip()
        if text:
            segments.append(
                ReadingDuetSegmentDTO(
                    turn_index=len(segments),
                    role=role,  # type: ignore[arg-type]
                    block_type=block_type,
                    line_indices=line_idxs,
                    word_indices=word_idxs,
                    text=text,
                )
            )
    return segments
