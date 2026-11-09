from __future__ import annotations

import hashlib
import random
from typing import Any

from app.services.tutor_questions.text_utils import (
    find_subsequence,
    normalize_text,
    tokenize,
)
from app.services.tutor_questions.types import DraftQuestion, SourcePage

QUESTION_TYPES = {"FACTUAL", "CLOZE", "VOCABULARY"}
DIFFICULTIES = {"EASY", "MEDIUM", "HARD"}
MAX_PROMPT_CHARS = 220
MAX_CHOICE_CHARS = 80
MAX_CHOICE_WORDS = 10
MIN_EVIDENCE_TOKENS = 2


def _locate_evidence(
    evidence: str, pages: list[SourcePage], preferred_page_number: int | None
) -> tuple[SourcePage, int, int] | None:
    """Evidence must exist verbatim in the text the child read (anti-hallucination)."""

    needle = tokenize(evidence)
    if len(needle) < MIN_EVIDENCE_TOKENS:
        return None
    ordered = sorted(
        pages, key=lambda page: page.page_number != preferred_page_number
    )
    for page in ordered:
        # Keep the original word index of every normalized sub-token so the
        # stored source span points at real PageRevisionWord positions even when
        # a word is pure punctuation or splits into several tokens.
        entries: list[tuple[int, str]] = []
        for word_index, token in enumerate(page.tokens):
            entries.extend((word_index, part) for part in normalize_text(token).split())
        start = find_subsequence([part for _, part in entries], needle)
        if start is not None:
            return page, entries[start][0], entries[start + len(needle) - 1][0] + 1
    return None


def _shuffled(choices: list[str], correct_index: int, seed: str) -> tuple[list[str], int]:
    """Avoid always placing the right answer first; stable for the same question."""

    order = list(range(len(choices)))
    random.Random(int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12], 16)).shuffle(order)
    return [choices[i] for i in order], order.index(correct_index)


def validate_draft(raw: Any, pages: list[SourcePage], seed: str) -> DraftQuestion | None:
    """Return a safe DraftQuestion or None. Never raises for malformed model output."""

    if not isinstance(raw, dict):
        return None
    question_type = str(raw.get("type", "")).strip().upper()
    prompt = " ".join(str(raw.get("prompt", "")).split())
    difficulty = str(raw.get("difficulty", "EASY")).strip().upper()
    evidence = str(raw.get("evidence", ""))
    choices_raw = raw.get("choices")
    correct_index = raw.get("correct_index")
    page_number = raw.get("page_number")

    if question_type not in QUESTION_TYPES or difficulty not in DIFFICULTIES:
        question_type = question_type if question_type in QUESTION_TYPES else ""
        if not question_type:
            return None
        difficulty = "EASY"
    if not prompt or len(prompt) > MAX_PROMPT_CHARS:
        return None
    if not isinstance(choices_raw, list) or not 3 <= len(choices_raw) <= 4:
        return None
    if isinstance(correct_index, bool) or not isinstance(correct_index, int):
        return None
    if not 0 <= correct_index < len(choices_raw):
        return None

    choices = [" ".join(str(choice).split()) for choice in choices_raw]
    normalized = [normalize_text(choice) for choice in choices]
    if any(
        not choice or len(choice) > MAX_CHOICE_CHARS or len(choice.split()) > MAX_CHOICE_WORDS
        for choice in choices
    ):
        return None
    if len(set(normalized)) != len(normalized):
        return None
    if question_type == "CLOZE" and "____" not in prompt:
        return None

    located = _locate_evidence(
        evidence, pages, page_number if isinstance(page_number, int) else None
    )
    if located is None:
        return None
    page, start, end = located

    shuffled, new_correct = _shuffled(choices, correct_index, f"{seed}:{prompt}")
    return DraftQuestion(
        type=question_type,
        prompt=prompt,
        choices=tuple(shuffled),
        correct_index=new_correct,
        difficulty=difficulty,
        page_id=page.page_id,
        revision_id=page.revision_id,
        start_word_index=start,
        end_word_index_exclusive=end,
    )


def validate_drafts(
    items: Any, pages: list[SourcePage], *, count: int, seed: str
) -> list[DraftQuestion]:
    """Keep valid, de-duplicated questions up to count."""

    if isinstance(items, dict):
        items = items.get("questions")
    if not isinstance(items, list):
        return []
    result: list[DraftQuestion] = []
    seen: set[str] = set()
    for raw in items:
        draft = validate_draft(raw, pages, seed)
        if draft is None:
            continue
        key = normalize_text(draft.prompt)
        if key in seen:
            continue
        seen.add(key)
        result.append(draft)
        if len(result) >= count:
            break
    return result
