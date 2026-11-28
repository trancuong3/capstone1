from __future__ import annotations

import hashlib
import random

from app.services.tutor_questions.text_utils import normalize_text
from app.services.tutor_questions.types import DraftQuestion, SourcePage

# Very common Vietnamese function words are poor cloze targets.
_STOPWORDS = frozenset(
    "và là của có không cho các một những được trong với này đó khi thì mà đã sẽ rất cũng như "
    "ở đi ra vào lên xuống lại còn nhưng nên vì để từ tôi bạn em anh chị ông bà con cái chiếc".split()
)
_MIN_SENTENCE_WORDS = 5
_MAX_SENTENCE_WORDS = 18
_MIN_TARGET_CHARS = 3


def _stable_random(seed: str) -> random.Random:
    return random.Random(int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12], 16))


def _sentences(page: SourcePage) -> list[tuple[int, int]]:
    """Return (start, end_exclusive) word ranges split on punctuation, Studio V2 blocks, or poem lines."""

    # 1. If Studio V2 canonical blocks provide valid token spans, respect block boundaries first.
    block_spans: list[tuple[int, int]] = []
    if page.blocks:
        total = len(page.tokens)
        for blk in page.blocks:
            if not isinstance(blk, dict):
                continue
            if blk.get("decision", "KEEP") == "EXCLUDE" or blk.get("in_canonical", True) is False:
                continue
            btype = str(blk.get("block_type") or "")
            if btype in {"PAGE_NUMBER", "RUNNING_HEADER", "PUBLISHER_META", "NOISE_OCR"}:
                continue
            src = blk.get("source_word_indices")
            if isinstance(src, list) and src:
                valid = sorted(
                    i for i in src if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < total
                )
                if valid and valid[-1] - valid[0] + 1 == len(valid):
                    b_start, b_end = valid[0], valid[-1] + 1
                    sub_start = b_start
                    for idx in range(b_start, b_end):
                        if page.tokens[idx].rstrip("\"'”’)»").endswith((".", "!", "?", "…")):
                            block_spans.append((sub_start, idx + 1))
                            sub_start = idx + 1
                    if sub_start < b_end:
                        block_spans.append((sub_start, b_end))
        if block_spans:
            return block_spans

    # 2. For POEM pages (or newline-structured verses without sentence periods), align line breaks to tokens.
    if (page.page_kind or "").upper() == "POEM" and "\n" in page.text:
        line_spans: list[tuple[int, int]] = []
        cursor = 0
        total = len(page.tokens)
        for raw_line in page.text.splitlines():
            line_words = raw_line.split()
            if not line_words or cursor >= total:
                continue
            end_cursor = min(total, cursor + len(line_words))
            line_spans.append((cursor, end_cursor))
            cursor = end_cursor
        if line_spans:
            # Pair short 3-4 word verse lines if needed so spans satisfy _MIN_SENTENCE_WORDS.._MAX_SENTENCE_WORDS
            merged: list[tuple[int, int]] = []
            idx = 0
            while idx < len(line_spans):
                s, e = line_spans[idx]
                if (e - s) < _MIN_SENTENCE_WORDS and (idx + 1) < len(line_spans):
                    _, e2 = line_spans[idx + 1]
                    if (e2 - s) <= _MAX_SENTENCE_WORDS:
                        merged.append((s, e2))
                        idx += 2
                        continue
                merged.append((s, e))
                idx += 1
            return merged

    spans: list[tuple[int, int]] = []
    start = 0
    for index, token in enumerate(page.tokens):
        if token.rstrip("\"'”’)»").endswith((".", "!", "?", "…")):
            spans.append((start, index + 1))
            start = index + 1
    if start < len(page.tokens):
        spans.append((start, len(page.tokens)))
    return spans


def _is_target(token: str) -> bool:
    word = normalize_text(token)
    return (
        len(word) >= _MIN_TARGET_CHARS
        and " " not in word
        and word not in _STOPWORDS
        and not word.isdigit()
    )


def generate_rule_based(
    pages: list[SourcePage], *, count: int, seed: str
) -> list[DraftQuestion]:
    """Offline cloze (fill-in-the-blank) questions built only from the read text.

    This is the last fallback so a child can always finish the activity even when
    every AI provider is disabled, rate limited or offline.
    """

    rng = _stable_random(seed)
    vocabulary: dict[str, str] = {}
    for page in pages:
        for token in page.tokens:
            if _is_target(token):
                vocabulary.setdefault(normalize_text(token), token.strip(",.;:!?…\"'“”‘’()"))

    candidates: list[tuple[SourcePage, int, int]] = []
    for page in pages:
        for start, end in _sentences(page):
            if _MIN_SENTENCE_WORDS <= end - start <= _MAX_SENTENCE_WORDS:
                candidates.append((page, start, end))
    rng.shuffle(candidates)

    questions: list[DraftQuestion] = []
    used_targets: set[str] = set()
    for page, start, end in candidates:
        if len(questions) >= count:
            break
        targets = [
            index
            for index in range(start, end)
            if _is_target(page.tokens[index])
            and normalize_text(page.tokens[index]) not in used_targets
        ]
        if not targets:
            continue
        target_index = rng.choice(targets)
        answer_key = normalize_text(page.tokens[target_index])
        distractor_pool = [
            surface for key, surface in vocabulary.items() if key != answer_key
        ]
        if len(distractor_pool) < 2:
            continue
        # Prefer distractors of similar length so the answer is not obvious by shape.
        distractor_pool.sort(
            key=lambda surface: (abs(len(surface) - len(answer_key)), rng.random())
        )
        distractors = distractor_pool[: min(3, len(distractor_pool))]
        answer_surface = vocabulary.get(answer_key, page.tokens[target_index])
        choices = [answer_surface, *distractors]
        rng.shuffle(choices)
        sentence = " ".join(
            "____" if index == target_index else page.tokens[index]
            for index in range(start, end)
        )
        used_targets.add(answer_key)
        questions.append(
            DraftQuestion(
                type="CLOZE",
                prompt=f"Điền từ còn thiếu: {sentence}",
                choices=tuple(choices),
                correct_index=choices.index(answer_surface),
                difficulty="EASY",
                page_id=page.page_id,
                revision_id=page.revision_id,
                start_word_index=start,
                end_word_index_exclusive=end,
            )
        )
    return questions
