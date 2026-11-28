"""Dialogue Role-Play & Turn-Taking Script Parser for Feature #2 — Vietnamese Co-Reading.

Splits Vietnamese page text into ordered turns (`NARRATOR`, `CHARACTER_A`, `CHARACTER_B`):
  - Detects Vietnamese typographic quotes (`“...”`, `„...”`, `«...»`), ASCII quotes (`"..."`),
    and dialogue dashes (`- ...`, `– ...`, `— ...`) without overlapping spans.
  - Locks `NARRATOR` and all pedagogical coaching prompts (`coaching_voice_id`) strictly to
    the session's primary teacher voice (`SessionVoiceLock`).
  - Unlocks multi-voice selection from `STATIC_LOCAL_VOICES` ONLY for tagged character dialogue
    (`CHARACTER_A`, `CHARACTER_B`), guaranteeing character voices differ from each other and
    from the locked primary teacher voice.
  - Splits multi-sentence narrative passages into natural sentence turns when needed and assigns
    alternating `turn_owner` (`"AI_OR_PARENT"` -> `"CHILD"` -> `"AI_OR_PARENT"` -> `"CHILD"`)
    for Turn-Taking / Echo Reading.
"""

from __future__ import annotations

import re
import unicodedata

from app.providers.local_voice_provider import (
    DEFAULT_LOCAL_VOICE_ID,
    KNOWN_LOCAL_VOICE_IDS,
    STATIC_LOCAL_VOICES,
)
from app.schemas.co_reading import (
    DEFAULT_CHILD_TURN_PROMPT_VI,
    DialogueTurn,
    TurnOwner,
    TurnRole,
)

# Vietnamese quoted speech: “...”, „...”, «...», or "..."
_QUOTED_DIALOGUE_RE = re.compile(
    r"(?:"
    r"[\u201c\u201e]([^\u201c\u201d\u201e\u201f\n]{1,600}?)[\u201d\u201f]"
    r"|\u00ab([^\u00ab\u00bb\n]{1,600}?)\u00bb"
    r"|\"([^\"\n]{1,600}?)\""
    r")"
)

# Line-leading Vietnamese dialogue dash: "- Chào mẹ!" or "— Con đi học về rồi ạ!"
# Optional trailing attribution after dash: "- Chào bạn! — Thỏ trắng nói."
_DASH_DIALOGUE_LINE_RE = re.compile(
    r"^[ \t]*[\-\u2013\u2014][ \t]*(.+?)\s*$"
)
_TRAILING_ATTRIBUTION_SPLIT_RE = re.compile(
    r"^(.+?[.!?…])\s*[\-\u2013\u2014][ \t]*(.+)$"
)

# Sentence splitter for narrative passages
_NARRATIVE_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…;])\s+|\n+")

_PREFERRED_CHARACTER_VOICES: tuple[str, ...] = (
    "local_north_ngoc_linh",
    "local_north_thien_minh",
    "local_south_my_duyen",
    "local_south_thai_son",
    "local_south_thuc_doan",
    "local_central_ngoc_tran",
    "local_central_quang_son",
)

_SPEAKER_LABELS: dict[TurnRole, str] = {
    "NARRATOR": "Người dẫn chuyện",
    "CHARACTER_A": "Nhân vật A",
    "CHARACTER_B": "Nhân vật B",
}


def resolve_teacher_voice_id(requested_voice_id: str | None) -> str:
    """Resolve the session's primary teacher voice ID (defaulting safely to Cô Trúc Ly)."""
    candidate = (requested_voice_id or "").strip()
    if candidate in KNOWN_LOCAL_VOICE_IDS:
        return candidate
    return DEFAULT_LOCAL_VOICE_ID


def get_voice_display_name(voice_id: str) -> str:
    for entry in STATIC_LOCAL_VOICES:
        if entry["voice_id"] == voice_id:
            return str(entry["name"])
    return voice_id


def select_character_voices(teacher_voice_id: str) -> tuple[str, str]:
    """Select two distinct character voices from STATIC_LOCAL_VOICES != teacher_voice_id."""
    picked: list[str] = []
    for vid in _PREFERRED_CHARACTER_VOICES:
        if vid != teacher_voice_id and vid in KNOWN_LOCAL_VOICE_IDS and vid not in picked:
            picked.append(vid)
        if len(picked) >= 2:
            break

    if len(picked) < 2:
        for entry in STATIC_LOCAL_VOICES:
            vid = str(entry["voice_id"])
            if vid != teacher_voice_id and vid not in picked:
                picked.append(vid)
            if len(picked) >= 2:
                break

    char_a = picked[0] if len(picked) >= 1 else teacher_voice_id
    char_b = picked[1] if len(picked) >= 2 else char_a
    return char_a, char_b


def tokenize_turn_words(text: str) -> list[str]:
    """Split a turn's text into displayable reading tokens."""
    cleaned = unicodedata.normalize("NFC", text or "").strip()
    if not cleaned:
        return []
    tokens: list[str] = []
    for raw in cleaned.split():
        stripped = raw.strip("“”„‟\"'‘’«»()[]{}—–-")
        if stripped and any(ch.isalnum() for ch in stripped):
            tokens.append(stripped)
    return tokens


def _split_narrative_chunk(chunk: str) -> list[str]:
    """Split a narrative block into clean sentence-sized segments."""
    cleaned = re.sub(r"^[ \t]*[\-\u2013\u2014,:;]+[ \t]*", "", chunk.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return []
    parts = [p.strip() for p in _NARRATIVE_SENTENCE_SPLIT_RE.split(cleaned) if p and p.strip()]
    return [p for p in parts if any(ch.isalnum() for ch in p)]


def _extract_raw_segments(page_text: str) -> list[tuple[bool, str]]:
    """Extract ordered `(is_dialogue, segment_text)` pairs without overlapping matches."""
    normalized = unicodedata.normalize("NFC", page_text or "").replace("\r\n", "\n").replace("\r", "\n")
    segments: list[tuple[bool, str]] = []

    for raw_line in normalized.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        # Case 1: Line contains explicit quoted dialogue (“...”, "...", «...»)
        quote_matches = list(_QUOTED_DIALOGUE_RE.finditer(line))
        if quote_matches:
            # Strip leading dialogue dash if author used both "- “...”"
            cursor = 0
            for m in quote_matches:
                before = line[cursor : m.start()].strip()
                for narr in _split_narrative_chunk(before):
                    segments.append((False, narr))
                quoted_inner = (m.group(1) or m.group(2) or m.group(3) or "").strip()
                if quoted_inner and any(ch.isalnum() for ch in quoted_inner):
                    segments.append((True, quoted_inner))
                cursor = m.end()
            after = line[cursor:].strip()
            for narr in _split_narrative_chunk(after):
                segments.append((False, narr))
            continue

        # Case 2: Line starts with a Vietnamese dialogue dash (- ... or — ...)
        dash_match = _DASH_DIALOGUE_LINE_RE.match(line)
        if dash_match:
            body = dash_match.group(1).strip()
            attr_match = _TRAILING_ATTRIBUTION_SPLIT_RE.match(body)
            if attr_match:
                spoken_part = attr_match.group(1).strip()
                narr_part = attr_match.group(2).strip()
                if spoken_part and any(ch.isalnum() for ch in spoken_part):
                    segments.append((True, spoken_part))
                for narr in _split_narrative_chunk(narr_part):
                    segments.append((False, narr))
            elif body and any(ch.isalnum() for ch in body):
                segments.append((True, body))
            continue

        # Case 3: Pure narrative line -> split into sentence segments
        for narr in _split_narrative_chunk(line):
            segments.append((False, narr))

    # If a single long narrative sentence has multiple clauses (comma/semicolon) and only 1 segment,
    # split gently at major clause boundary so parent/AI + child can still take turns when possible.
    if len(segments) == 1 and not segments[0][0]:
        only_text = segments[0][1]
        clauses = [c.strip() for c in re.split(r"(?<=[,;:])\s+", only_text) if c.strip()]
        if len(clauses) >= 2 and all(len(c.split()) >= 3 for c in clauses[:2]):
            midpoint = len(clauses) // 2
            first_half = ", ".join(clauses[:midpoint]).rstrip(",")
            second_half = ", ".join(clauses[midpoint:])
            segments = [(False, first_half), (False, second_half)]

    return segments


def parse_script(
    page_text: str,
    teacher_voice_id: str | None = None,
) -> list[DialogueTurn]:
    """Parse Vietnamese page text into ordered Co-Reading Role-Play & Turn-Taking turns."""
    locked_teacher_voice = resolve_teacher_voice_id(teacher_voice_id)
    teacher_voice_name = get_voice_display_name(locked_teacher_voice)
    char_voice_a, char_voice_b = select_character_voices(locked_teacher_voice)

    raw_segments = _extract_raw_segments(page_text)
    if not raw_segments:
        fallback_text = unicodedata.normalize("NFC", page_text or "").strip()
        if not fallback_text:
            return []
        raw_segments = [(False, fallback_text)]

    turns: list[DialogueTurn] = []
    dialogue_counter = 0

    for idx, (is_dialogue, seg_text) in enumerate(raw_segments):
        owner: TurnOwner = "AI_OR_PARENT" if idx % 2 == 0 else "CHILD"
        if is_dialogue:
            role: TurnRole = "CHARACTER_A" if dialogue_counter % 2 == 0 else "CHARACTER_B"
            dialogue_counter += 1
            turn_voice_id = char_voice_a if role == "CHARACTER_A" else char_voice_b
            turn_voice_name = get_voice_display_name(turn_voice_id)
        else:
            role = "NARRATOR"
            turn_voice_id = locked_teacher_voice
            turn_voice_name = teacher_voice_name

        turns.append(
            DialogueTurn(
                index=idx,
                role=role,
                speaker_label=_SPEAKER_LABELS[role],
                text=seg_text,
                words=tokenize_turn_words(seg_text),
                voice_id=turn_voice_id,
                voice_name=turn_voice_name,
                is_character_dialogue=is_dialogue,
                turn_owner=owner,
                coaching_prompt_vi=(
                    DEFAULT_CHILD_TURN_PROMPT_VI if owner == "CHILD" else None
                ),
                coaching_voice_id=locked_teacher_voice,
            )
        )

    return turns


def summarize_character_voices(turns: list[DialogueTurn]) -> dict[str, str]:
    """Return `{role -> voice_id}` for character dialogue roles present in `turns`."""
    mapping: dict[str, str] = {}
    for turn in turns:
        if turn.role != "NARRATOR" and turn.role not in mapping:
            mapping[turn.role] = turn.voice_id
    return mapping
