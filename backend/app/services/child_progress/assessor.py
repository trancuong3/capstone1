"""Facts about a child's reading period and the offline (rule-based) comments."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.schemas.child_progress import ActionRead, AssessmentTextRead, WeaknessRead
from app.services.child_progress.metrics import WindowMetrics
from app.services.child_progress.scoring import ComponentScore, grade_for

TYPE_LABELS = {
    "FACTUAL": "câu hỏi về chi tiết trong bài",
    "CLOZE": "câu điền từ còn thiếu",
    "VOCABULARY": "câu hỏi về nghĩa của từ",
}


@dataclass(frozen=True)
class AssessmentFacts:
    days: int
    metrics: WindowMetrics
    previous: WindowMetrics
    components: list[ComponentScore]
    previous_components: list[ComponentScore]
    overall: int | None
    previous_overall: int | None
    difficult_words: list[dict[str, Any]]

    @property
    def delta(self) -> int | None:
        if self.overall is None or self.previous_overall is None:
            return None
        return self.overall - self.previous_overall

    def score(self, key: str) -> int | None:
        return next((c.score for c in self.components if c.key == key), None)


def weakest_comprehension_type(metrics: WindowMetrics) -> str | None:
    """The question type with the lowest first-try accuracy (needs >= 2 answers)."""

    candidates = [
        (correct / answered, name)
        for name, (answered, correct) in metrics.comprehension_by_type.items()
        if answered >= 2
    ]
    if len(candidates) < 2:
        return None
    candidates.sort()
    worst, best = candidates[0], candidates[-1]
    return worst[1] if best[0] - worst[0] >= 0.2 else None


def facts_payload(facts: AssessmentFacts) -> dict[str, Any]:
    """The only data an AI model receives: aggregates, no names or identifiers."""

    m = facts.metrics
    return {
        "period_days": facts.days,
        "overall_score": facts.overall,
        "grade": (grade_for(facts.overall) or (None, None))[1],
        "previous_period_overall_score": facts.previous_overall,
        "score_change": facts.delta,
        "components": [
            {
                "name": c.label,
                "score": c.score,
                "previous_score": next(
                    (p.score for p in facts.previous_components if p.key == c.key), None
                ),
                "explanation": c.detail,
            }
            for c in facts.components
        ],
        "metrics": {
            "completed_sessions": m.sessions,
            "days_with_reading": m.active_days,
            "reading_minutes": m.reading_minutes,
            "different_books": m.books,
            "words_read": m.words_read,
            "accuracy_percent": m.accuracy_pct,
            "page_coverage_percent": m.coverage_pct,
            "skipped_words_percent": m.skipped_rate_pct,
            "misread_words_percent": m.substitution_rate_pct,
            "long_pauses": m.hesitations,
            "repeated_words": m.repeated_words,
            "comprehension_first_try_percent": m.comprehension_first_try_pct,
            "comprehension_by_question_type": {
                TYPE_LABELS.get(name, name): {"answered": a, "first_try_correct": c}
                for name, (a, c) in m.comprehension_by_type.items()
            },
            "single_word_retries_succeeded": m.retry_confirmed,
            "single_word_retries_failed": m.retry_failed,
        },
        "weekly": [
            {
                "week": index + 1,
                "sessions": week["sessions"],
                "minutes": week["minutes"],
                "accuracy_percent": week["accuracy_pct"],
            }
            for index, week in enumerate(m.weekly)
        ],
        "difficult_words": [
            {"word": w["word"], "times": w["times"], "child_said": w["heard_as"]}
            for w in facts.difficult_words
        ],
    }


def _headline(grade_key: str | None) -> str:
    return {
        "EXCELLENT": "Bé đang đọc rất tốt!",
        "GOOD": "Bé đang tiến bộ tốt",
        "FAIR": "Bé đang dần quen với việc đọc",
        "NEEDS_SUPPORT": "Bé cần được đồng hành thêm",
    }.get(grade_key or "", "Chưa đủ dữ liệu để đánh giá")


def _encouragement(grade_key: str | None) -> str:
    return {
        "EXCELLENT": "Bé giỏi lắm! Cứ đọc đều mỗi ngày là bé sẽ còn giỏi hơn nữa.",
        "GOOD": "Bé làm tốt lắm! Thêm một chút luyện tập nữa là bé sẽ đọc thật trôi chảy.",
        "FAIR": "Bé đang cố gắng rất nhiều, mỗi ngày đọc thêm một chút là bé sẽ tiến bộ nhé!",
    }.get(grade_key or "", "Mỗi lần đọc là một bước tiến. Cùng đọc tiếp nhé bé!")


def rule_based_assessment(facts: AssessmentFacts) -> AssessmentTextRead:
    """Honest, evidence-based comments built from the numbers alone."""

    m = facts.metrics
    grade = grade_for(facts.overall)
    grade_key = grade[0] if grade else None

    if facts.overall is None:
        summary = (
            f"Trong {facts.days} ngày qua ViRead chưa có đủ dữ liệu để chấm điểm cho bé "
            f"({m.sessions} buổi đọc hoàn thành). Hãy cho bé đọc thêm vài trang bằng chế độ "
            "đọc có nhận diện giọng nói và trả lời câu hỏi cuối bài để có đánh giá chính xác hơn."
        )
    else:
        summary = (
            f"Trong {facts.days} ngày qua bé hoàn thành {m.sessions} buổi đọc "
            f"({m.reading_minutes} phút, {m.active_days} ngày có đọc). "
            f"Điểm tổng hợp là {facts.overall}/100, xếp loại {grade[1] if grade else ''}."
        )
        if facts.delta is not None:
            if facts.delta >= 3:
                summary += f" Điểm tăng {facts.delta} so với kỳ trước, bé đang tiến bộ."
            elif facts.delta <= -3:
                summary += f" Điểm giảm {abs(facts.delta)} so với kỳ trước, ba mẹ nên động viên bé luyện thêm."
            else:
                summary += " Kết quả khá ổn định so với kỳ trước."

    strengths: list[str] = []
    weaknesses: list[WeaknessRead] = []
    actions: list[ActionRead] = []

    accuracy, fluency = facts.score("ACCURACY"), facts.score("FLUENCY")
    comprehension, consistency = facts.score("COMPREHENSION"), facts.score("CONSISTENCY")
    words = [w["word"] for w in facts.difficult_words]

    if accuracy is not None and accuracy >= 80:
        strengths.append(f"Bé đọc đúng {m.accuracy_pct:g}% số từ đã đọc tới, rất chính xác.")
    if fluency is not None and fluency >= 80:
        strengths.append("Bé đọc khá trôi chảy, ít ngập ngừng và ít phải lặp lại từ.")
    if comprehension is not None and comprehension >= 75:
        strengths.append(
            f"Bé hiểu bài tốt: trả lời đúng ngay lần đầu {m.comprehension_first_try_pct:g}% câu hỏi."
        )
    if consistency is not None and consistency >= 80:
        strengths.append(f"Bé duy trì thói quen đọc đều đặn ({m.active_days} ngày có đọc).")
    if facts.delta is not None and facts.delta >= 3:
        strengths.append(f"Điểm tổng hợp tăng {facts.delta} điểm so với kỳ trước.")
    if m.retry_confirmed > m.retry_failed and m.retry_confirmed >= 2:
        strengths.append(
            f"Bé đọc lại đúng {m.retry_confirmed} từ khó sau khi luyện từng từ."
        )
    if not strengths and m.sessions > 0:
        strengths.append(f"Bé đã hoàn thành {m.sessions} buổi đọc, đó là một khởi đầu rất tốt.")

    if accuracy is not None and accuracy < 75:
        if (m.skipped_rate_pct or 0) >= (m.substitution_rate_pct or 0):
            weaknesses.append(
                WeaknessRead(
                    area="Hay bỏ sót từ khi đọc",
                    detail=f"Bé bỏ sót khoảng {m.skipped_rate_pct:g}% số từ đã đọc tới.",
                )
            )
            actions.append(
                ActionRead(
                    title="Đọc chậm và chỉ từng từ",
                    detail="Cùng bé dùng ngón tay chỉ vào từng từ khi đọc để bé không nhảy cóc, mỗi lần 5–10 phút.",
                    audience="PARENT",
                )
            )
        else:
            weaknesses.append(
                WeaknessRead(
                    area="Hay đọc nhầm từ",
                    detail=f"Bé đọc nhầm khoảng {m.substitution_rate_pct:g}% số từ đã đọc tới.",
                )
            )
            actions.append(
                ActionRead(
                    title="Ôn lại các từ hay đọc nhầm",
                    detail="Cùng bé đọc to từng từ khó 3 lần, rồi đặt một câu đơn giản với từ đó."
                    + (f" Bắt đầu với: {', '.join(words[:4])}." if words else ""),
                    audience="CHILD",
                )
            )
    if fluency is not None and fluency < 65:
        weaknesses.append(
            WeaknessRead(
                area="Đọc chưa trôi chảy",
                detail=f"Có {m.hesitations} lần dừng lâu và {m.repeated_words} lần lặp từ trong các lượt đọc.",
            )
        )
        actions.append(
            ActionRead(
                title="Đọc lặp lại một đoạn ngắn",
                detail="Chọn một đoạn 2–3 câu, bé đọc lại 2–3 lần cho đến khi trôi chảy rồi mới sang đoạn khác.",
                audience="CHILD",
            )
        )
    if comprehension is not None and comprehension < 65:
        weak_type = weakest_comprehension_type(m)
        detail = f"Bé chỉ trả lời đúng ngay lần đầu {m.comprehension_first_try_pct:g}% câu hỏi."
        if weak_type:
            detail += f" Bé yếu nhất ở {TYPE_LABELS.get(weak_type, weak_type)}."
        weaknesses.append(WeaknessRead(area="Hiểu nội dung bài đọc còn hạn chế", detail=detail))
        actions.append(
            ActionRead(
                title="Hỏi bé sau mỗi bài đọc",
                detail="Sau khi đọc, hỏi bé 'Ai? Ở đâu? Làm gì?' và để bé tự kể lại câu chuyện bằng lời của mình.",
                audience="PARENT",
            )
        )
    if consistency is not None and consistency < 50:
        weaknesses.append(
            WeaknessRead(
                area="Chưa đọc đều đặn",
                detail=f"Bé mới đọc {m.active_days} ngày trong {facts.days} ngày qua.",
            )
        )
        actions.append(
            ActionRead(
                title="Đặt lịch đọc cố định",
                detail="Chọn một giờ cố định mỗi ngày (10–15 phút) và dùng mục Quản lý đọc để đặt lịch nhắc.",
                audience="PARENT",
            )
        )
    if (m.coverage_pct or 100) < 60 and m.words_read >= 20:
        weaknesses.append(
            WeaknessRead(
                area="Thường dừng đọc sớm",
                detail=f"Bé mới đọc tới khoảng {m.coverage_pct:g}% nội dung mỗi trang.",
            )
        )
        actions.append(
            ActionRead(
                title="Khuyến khích đọc hết trang",
                detail="Đặt mục tiêu nhỏ: đọc hết một trang trước khi bấm Xong, và khen bé mỗi khi hoàn thành.",
                audience="PARENT",
            )
        )

    defaults = [
        ActionRead(
            title="Duy trì đọc mỗi ngày",
            detail="Mỗi ngày đọc 10–15 phút, ưu tiên những cuốn bé thích để giữ niềm vui đọc sách.",
            audience="PARENT",
        ),
        ActionRead(
            title="Thử một cuốn sách mới vừa sức",
            detail="Khi bé đã đọc ổn, chọn thêm một cuốn mới cùng mức độ để mở rộng vốn từ.",
            audience="CHILD",
        ),
    ]
    for item in defaults:
        if len(actions) >= 2:
            break
        actions.append(item)

    return AssessmentTextRead(
        source="RULE_BASED",
        model=None,
        headline=_headline(grade_key),
        summary=summary,
        strengths=strengths[:4],
        weaknesses=weaknesses[:4],
        actions=actions[:5],
        practice_words=words[:6],
        encouragement=_encouragement(grade_key),
    )
