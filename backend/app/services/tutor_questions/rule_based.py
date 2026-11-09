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
    """Return (start, end_exclusive) word ranges split on sentence punctuation."""

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
