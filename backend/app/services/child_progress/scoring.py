"""Transparent 0-100 scores computed from metrics (never by an AI)."""

from __future__ import annotations

from dataclasses import dataclass

from app.services.child_progress.metrics import WindowMetrics

MIN_WORDS_FOR_READING_SCORES = 20
MIN_ANSWERS_FOR_COMPREHENSION = 3
TARGET_SESSIONS_PER_WEEK = 3
DISFLUENCY_PENALTY_PER_POINT = 5  # each pause/repeat per 100 words costs 5 points

WEIGHTS = {
    "ACCURACY": 0.40,
    "COMPREHENSION": 0.25,
    "FLUENCY": 0.20,
    "CONSISTENCY": 0.15,
}
LABELS = {
    "ACCURACY": "Đọc đúng",
    "FLUENCY": "Đọc trôi chảy",
    "COMPREHENSION": "Hiểu bài",
    "CONSISTENCY": "Chăm chỉ",
}
GRADES = (
    (85, "EXCELLENT", "Xuất sắc"),
    (70, "GOOD", "Tốt"),
    (55, "FAIR", "Khá"),
    (0, "NEEDS_SUPPORT", "Cần luyện thêm"),
)


@dataclass(frozen=True)
class ComponentScore:
    key: str
    label: str
    score: int | None
    detail: str


def _clamp(value: float) -> int:
    return max(0, min(100, round(value)))


def component_scores(metrics: WindowMetrics, days: int) -> list[ComponentScore]:
    enough_words = metrics.words_read >= MIN_WORDS_FOR_READING_SCORES

    if enough_words and metrics.accuracy_pct is not None:
        accuracy = _clamp(metrics.accuracy_pct)
        accuracy_detail = (
            f"Đọc đúng {metrics.correct_words}/{metrics.words_read} từ bé đã đọc tới "
            f"({metrics.accuracy_pct:g}%)."
        )
    else:
        accuracy = None
        accuracy_detail = "Chưa đủ lượt đọc có đối chiếu để chấm (cần ít nhất 20 từ)."

    if enough_words and metrics.hesitations_per_100_words is not None:
        rate = metrics.hesitations_per_100_words
        fluency = _clamp(100 - DISFLUENCY_PENALTY_PER_POINT * rate)
        fluency_detail = (
            f"{metrics.hesitations} lần ngập ngừng lâu và {metrics.repeated_words} lần lặp từ "
            f"(khoảng {rate:g} lần mỗi 100 từ)."
        )
    else:
        fluency = None
        fluency_detail = "Chưa đủ lượt đọc có đối chiếu để chấm độ trôi chảy."

    if (
        metrics.comprehension_answered >= MIN_ANSWERS_FOR_COMPREHENSION
        and metrics.comprehension_first_try_pct is not None
    ):
        comprehension = _clamp(metrics.comprehension_first_try_pct)
        comprehension_detail = (
            f"Trả lời đúng ngay lần đầu {metrics.comprehension_first_try_correct}/"
            f"{metrics.comprehension_answered} câu hỏi ({metrics.comprehension_first_try_pct:g}%)."
        )
    else:
        comprehension = None
        comprehension_detail = "Chưa đủ câu hỏi đã trả lời để chấm (cần ít nhất 3 câu)."

    if metrics.sessions > 0:
        expected_days = max(1, round(days * TARGET_SESSIONS_PER_WEEK / 7))
        consistency = _clamp(metrics.active_days * 100 / expected_days)
        consistency_detail = (
            f"Đọc {metrics.active_days} ngày trong {days} ngày qua "
            f"(mục tiêu khoảng {expected_days} ngày, {TARGET_SESSIONS_PER_WEEK} ngày mỗi tuần)."
        )
    else:
        consistency = None
        consistency_detail = "Bé chưa có buổi đọc hoàn thành nào trong kỳ này."

    return [
        ComponentScore("ACCURACY", LABELS["ACCURACY"], accuracy, accuracy_detail),
        ComponentScore("FLUENCY", LABELS["FLUENCY"], fluency, fluency_detail),
        ComponentScore("COMPREHENSION", LABELS["COMPREHENSION"], comprehension, comprehension_detail),
        ComponentScore("CONSISTENCY", LABELS["CONSISTENCY"], consistency, consistency_detail),
    ]


def overall_score(components: list[ComponentScore]) -> int | None:
    """Weighted mean over the components that have evidence.

    Needs reading or comprehension evidence: attendance alone is not a reading score.
    """

    available = {c.key: c.score for c in components if c.score is not None}
    if "ACCURACY" not in available and "COMPREHENSION" not in available:
        return None
    total_weight = sum(WEIGHTS[key] for key in available)
    return _clamp(sum(WEIGHTS[key] * score for key, score in available.items()) / total_weight)


def grade_for(score: int | None) -> tuple[str, str] | None:
    if score is None:
        return None
    for threshold, key, label in GRADES:
        if score >= threshold:
            return key, label
    return None
