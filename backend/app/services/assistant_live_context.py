from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import logging
import re
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import func, select

from app.models.book import Book
from app.models.ocr_inference_job import OcrInferenceJob
from app.models.profile import ChildProfile, Profile
from app.models.reading import ReadingSession
from app.schemas.assistant import (
    AssistantNavigationOffer,
    AssistantQuickAction,
    AssistantRoleScope,
)
from app.services.active_weak_words import (
    list_active_weak_words_for_child as list_active_weak_words,
)
from app.services.assistant_kb import (
    _expand_vietnamese_shorthand,
    fold_vietnamese,
    is_navigation_href_allowed,
    is_quick_action_href_allowed,
    sanitize_scoped_path,
)

logger = logging.getLogger(__name__)

LiveContextIntent = Literal[
    "my_children",
    "child_weak_words",
    "child_progress",
    "my_private_books",
    "admin_ops_summary",
]

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)")


def _sanitize_plain_text(raw: Any, *, max_len: int = 48) -> str:
    if not isinstance(raw, str):
        return ""
    cleaned = _EMAIL_RE.sub("[hidden]", raw)
    cleaned = _UUID_RE.sub("[id]", cleaned)
    cleaned = _PHONE_RE.sub("[hidden]", cleaned)
    cleaned = cleaned.replace("<", "").replace(">", "")
    cleaned = " ".join(cleaned.split()).strip()
    return cleaned[:max_len]


@dataclass(frozen=True)
class ChildSnapshot:
    alias: str
    grade: int
    is_selected: bool = False
    sessions_total: int = 0
    sessions_7d: int = 0
    weak_words: tuple[str, ...] = ()


@dataclass(frozen=True)
class LiveAssistantContext:
    role_scope: AssistantRoleScope
    intent: LiveContextIntent
    # Parent own-account snapshot (zero UUIDs, emails, phones, or tokens)
    children_count: int = 0
    children: tuple[ChildSnapshot, ...] = ()
    active_child_alias: str | None = None
    active_child_grade: int | None = None
    active_child_sessions_total: int = 0
    active_child_sessions_7d: int = 0
    active_child_weak_words: tuple[str, ...] = ()
    private_books_count: int = 0
    selected_child_ignored: bool = False
    # Admin aggregate-only telemetry (zero parent/child PII)
    catalog_books_count: int | None = None
    private_books_count_total: int | None = None
    active_parents_count: int | None = None
    ocr_queued_running_count: int | None = None
    ocr_failed_count: int | None = None


_PARENT_WEAK_WORDS_MARKERS: tuple[str, ...] = (
    "be yeu tu nao",
    "con yeu tu nao",
    "be dang yeu tu",
    "con dang yeu tu",
    "be hay sai tu nao",
    "con hay sai tu nao",
    "be hay sai am gi",
    "con hay sai am gi",
    "hay sai am gi",
    "be hay vap tu nao",
    "be doc sai tu nao",
    "tu kho cua be",
    "tu kho cua con",
    "tu yeu cua be",
    "tu yeu cua con",
    "tu can luyen cua be",
    "tu can on cua be",
    "danh sach tu kho cua be",
    "be sai nhieu tu nao",
    "weak words of",
    "which words does my child",
    "what words is my child",
    "my child weak words",
    "child weak words",
    "child difficult words",
    "struggling with what words",
    "mispronounced words",
)

_PARENT_PROGRESS_MARKERS: tuple[str, ...] = (
    "hom nay be nen doc gi",
    "hom nay con nen doc gi",
    "be nen doc gi hom nay",
    "con nen doc gi hom nay",
    "goi y doc hom nay",
    "tien do doc gan day",
    "tien do doc cua be",
    "tien do cua be",
    "tien do cua con",
    "tuan nay be doc may buoi",
    "tuan nay con doc may buoi",
    "be doc duoc may buoi",
    "con doc duoc may buoi",
    "be da doc may buoi",
    "be da doc bao nhieu buoi",
    "tuan nay doc bao nhieu buoi",
    "tuan nay doc may buoi",
    "tinh hinh doc cua be",
    "ket qua doc cua be",
    "buoi doc gan day cua be",
    "what should my child read today",
    "recent reading progress",
    "how many sessions this week",
    "sessions this week",
    "my child progress",
)

_PARENT_CHILDREN_MARKERS: tuple[str, ...] = (
    "may be",
    "co bao nhieu be",
    "nha co may be",
    "toi co may be",
    "minh co may be",
    "ho so be cua toi",
    "ho so be cua minh",
    "ho so con cua toi",
    "cac be cua toi",
    "cac be cua minh",
    "danh sach be cua toi",
    "danh sach cac be",
    "thong tin cac be",
    "be nao dang",
    "my children",
    "my child profiles",
    "how many children",
    "list my children",
)

_PARENT_PRIVATE_BOOKS_MARKERS: tuple[str, ...] = (
    "sach cua toi co",
    "co bao nhieu sach cua toi",
    "toi co bao nhieu sach",
    "minh co bao nhieu sach",
    "sach da tai len",
    "truyen da tai len",
    "sach gia dinh da tai",
    "sach rieng cua toi",
    "truyen rieng cua toi",
    "sach toi da quet",
    "my uploaded books",
    "how many private books",
    "books i uploaded",
    "my scanned books",
)

_ADMIN_OPS_MARKERS: tuple[str, ...] = (
    "bao nhieu sach",
    "co may sach",
    "tong so sach",
    "bao nhieu phu huynh",
    "co bao nhieu phu huynh",
    "tac vu ocr dang cho",
    "ocr dang cho",
    "ocr dang loi",
    "tac vu loi",
    "job ocr loi",
    "tinh trang he thong luc nay",
    "tinh trang he thong",
    "trang thai he thong luc nay",
    "thong ke van hanh",
    "thong ke he thong",
    "tong quan van hanh",
    "so lieu van hanh",
    "how many books",
    "ocr jobs queued",
    "queued or failed ocr",
    "failed ocr jobs",
    "system status right now",
    "ops summary",
    "operations summary",
    "operations stats",
)


def detect_live_context_intent(
    message: str,
    role_scope: AssistantRoleScope,
) -> LiveContextIntent | None:
    """Detect whether the prompt asks for live tenant-scoped data.

    Public guests ALWAYS return None (zero DB queries).
    """
    if role_scope == "public":
        return None
    folded = _expand_vietnamese_shorthand(fold_vietnamese(message))
    if not folded:
        return None
    padded = f" {folded} "

    if role_scope == "parent":
        if any(f" {m} " in padded or m in folded for m in _PARENT_WEAK_WORDS_MARKERS):
            return "child_weak_words"
        if (
            "tu yeu" in folded
            and any(w in padded for w in (" be ", " con ", " nao ", " gi ", " cua "))
            and "vong lap" not in folded
            and "o dau" not in folded
        ):
            return "child_weak_words"
        if any(f" {m} " in padded or m in folded for m in _PARENT_PROGRESS_MARKERS):
            return "child_progress"
        if any(f" {m} " in padded or m in folded for m in _PARENT_PRIVATE_BOOKS_MARKERS):
            return "my_private_books"
        if (
            any(f" {m} " in padded or m in folded for m in _PARENT_CHILDREN_MARKERS)
            and "tao ho so" not in folded
            and "lam sao" not in folded
        ):
            return "my_children"
        return None

    if role_scope == "admin":
        if any(f" {m} " in padded or m in folded for m in _ADMIN_OPS_MARKERS):
            return "admin_ops_summary"
        return None

    return None


async def _scalar_count(db: Any, stmt: Any) -> int | None:
    try:
        scalar_fn = getattr(db, "scalar", None)
        if callable(scalar_fn):
            val = await scalar_fn(stmt)
        else:
            res = await db.execute(stmt)
            val = res.scalar_one_or_none()
        return int(val or 0)
    except Exception:
        return None


def _unpack_child_row(row: Any) -> tuple[UUID | None, str, int]:
    if hasattr(row, "Id") and hasattr(row, "Alias"):
        raw_id = getattr(row, "Id", None)
        raw_alias = getattr(row, "Alias", "")
        raw_grade = getattr(row, "Grade", 1)
    else:
        raw_id, raw_alias, raw_grade = row[0], row[1], row[2]
    parsed_id: UUID | None = None
    if isinstance(raw_id, UUID):
        parsed_id = raw_id
    elif raw_id is not None:
        try:
            parsed_id = UUID(str(raw_id))
        except (ValueError, TypeError):
            parsed_id = None
    alias = _sanitize_plain_text(str(raw_alias or ""), max_len=40) or "Bé"
    try:
        grade = max(1, min(5, int(raw_grade or 1)))
    except (TypeError, ValueError):
        grade = 1
    return parsed_id, alias, grade


async def _fetch_parent_context(
    db: Any,
    *,
    actor_uuid: UUID,
    selected_uuid: UUID | None,
    intent: LiveContextIntent,
) -> LiveAssistantContext:
    owned_rows_raw: list[Any] = []
    try:
        stmt = (
            select(ChildProfile.Id, ChildProfile.Alias, ChildProfile.Grade)
            .where(ChildProfile.ParentId == actor_uuid)
            .order_by(ChildProfile.CreatedAt.asc())
        )
        res = await db.execute(stmt)
        owned_rows_raw = list(res.all())
    except Exception as exc:
        logger.debug("Assistant parent children lookup skipped: %s", type(exc).__name__)
        owned_rows_raw = []

    owned_children: list[tuple[UUID | None, str, int]] = [
        _unpack_child_row(row) for row in owned_rows_raw
    ]

    matched_idx: int | None = None
    selected_child_ignored = False
    if selected_uuid is not None:
        for idx, (cid, _alias, _grade) in enumerate(owned_children):
            if cid is not None and cid == selected_uuid:
                matched_idx = idx
                break
        if matched_idx is None:
            # Strict IDOR defense: foreign or unowned child UUID is silently ignored.
            selected_child_ignored = True

    active_idx: int | None = matched_idx
    if active_idx is None and len(owned_children) == 1:
        active_idx = 0

    active_child_id: UUID | None = None
    active_alias: str | None = None
    active_grade: int | None = None
    sessions_total = 0
    sessions_7d = 0
    weak_words: tuple[str, ...] = ()

    if active_idx is not None:
        active_child_id, active_alias, active_grade = owned_children[active_idx]
        if active_child_id is not None:
            tot = await _scalar_count(
                db,
                select(func.count(ReadingSession.Id)).where(
                    ReadingSession.ChildId == active_child_id
                ),
            )
            sessions_total = tot if tot is not None else 0

            seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)
            s7 = await _scalar_count(
                db,
                select(func.count(ReadingSession.Id)).where(
                    ReadingSession.ChildId == active_child_id,
                    ReadingSession.StartedAt >= seven_days_ago,
                ),
            )
            sessions_7d = s7 if s7 is not None else 0

            try:
                raw_words = await list_active_weak_words(
                    db,
                    active_child_id,
                    parent_id=actor_uuid,
                    limit=5,
                )
                cleaned_words = [
                    w
                    for item in (raw_words or [])
                    if (w := _sanitize_plain_text(item, max_len=40))
                ][:5]
                weak_words = tuple(cleaned_words)
            except Exception as exc:
                logger.debug("Assistant weak words lookup skipped: %s", type(exc).__name__)
                weak_words = ()

    private_count = await _scalar_count(
        db,
        select(func.count(Book.Id)).where(
            Book.VisibilityScope == "PRIVATE",
            Book.OwnerParentId == actor_uuid,
            Book.IsDeleted.is_(False),
        ),
    )

    snapshots = tuple(
        ChildSnapshot(
            alias=alias,
            grade=grade,
            is_selected=(active_idx == idx),
            sessions_total=sessions_total if active_idx == idx else 0,
            sessions_7d=sessions_7d if active_idx == idx else 0,
            weak_words=weak_words if active_idx == idx else (),
        )
        for idx, (_cid, alias, grade) in enumerate(owned_children)
    )

    return LiveAssistantContext(
        role_scope="parent",
        intent=intent,
        children_count=len(snapshots),
        children=snapshots,
        active_child_alias=active_alias,
        active_child_grade=active_grade,
        active_child_sessions_total=sessions_total,
        active_child_sessions_7d=sessions_7d,
        active_child_weak_words=weak_words,
        private_books_count=private_count if private_count is not None else 0,
        selected_child_ignored=selected_child_ignored,
    )


async def _fetch_admin_context(
    db: Any,
    *,
    intent: LiveContextIntent,
) -> LiveAssistantContext:
    catalog_books_count = await _scalar_count(
        db,
        select(func.count(Book.Id)).where(
            Book.VisibilityScope == "CATALOG",
            Book.IsDeleted.is_(False),
        ),
    )
    private_books_count_total = await _scalar_count(
        db,
        select(func.count(Book.Id)).where(
            Book.VisibilityScope == "PRIVATE",
            Book.IsDeleted.is_(False),
        ),
    )
    active_parents_count = await _scalar_count(
        db,
        select(func.count(Profile.Id)).where(
            Profile.Role == "parent",
            Profile.Active == 1,
        ),
    )
    ocr_queued_running_count = await _scalar_count(
        db,
        select(func.count(OcrInferenceJob.Id)).where(
            OcrInferenceJob.Status.in_(("QUEUED", "CLAIMED", "RUNNING"))
        ),
    )
    ocr_failed_count = await _scalar_count(
        db,
        select(func.count(OcrInferenceJob.Id)).where(
            OcrInferenceJob.Status.in_(("FAILED_RETRYABLE", "DEAD_LETTER", "FAILED"))
        ),
    )
    return LiveAssistantContext(
        role_scope="admin",
        intent=intent,
        catalog_books_count=catalog_books_count,
        private_books_count_total=private_books_count_total,
        active_parents_count=active_parents_count,
        ocr_queued_running_count=ocr_queued_running_count,
        ocr_failed_count=ocr_failed_count,
    )


async def fetch_live_assistant_context(
    db: Any,
    *,
    role_scope: AssistantRoleScope,
    actor_uuid: UUID | None,
    selected_child_id: str | UUID | None,
    intent: LiveContextIntent | None,
    timeout_seconds: float = 0.85,
) -> LiveAssistantContext | None:
    """Fetch tenant-isolated live context under a strict timeout, failing safely to None."""
    if db is None or intent is None or role_scope == "public" or actor_uuid is None:
        return None

    selected_uuid: UUID | None = None
    if isinstance(selected_child_id, UUID):
        selected_uuid = selected_child_id
    elif isinstance(selected_child_id, str) and selected_child_id.strip():
        try:
            selected_uuid = UUID(selected_child_id.strip())
        except (ValueError, TypeError):
            selected_uuid = None

    async def _run() -> LiveAssistantContext:
        if role_scope == "parent":
            return await _fetch_parent_context(
                db,
                actor_uuid=actor_uuid,
                selected_uuid=selected_uuid,
                intent=intent,
            )
        return await _fetch_admin_context(db, intent=intent)

    try:
        return await asyncio.wait_for(_run(), timeout=max(0.1, float(timeout_seconds)))
    except (TimeoutError, Exception) as exc:
        logger.debug("Live assistant context fetch degraded to None: %s", type(exc).__name__)
        return None


def build_live_grounding_block(ctx: LiveAssistantContext) -> str:
    """Serialize verified tenant-scoped live summary without any raw UUIDs or PII."""
    if ctx.role_scope == "admin":
        def _fmt(val: int | None) -> str:
            return str(val) if val is not None else "unavailable"

        return (
            "<VERIFIED_ADMIN_OPS_SUMMARY>\n"
            f"catalog_books_count: {_fmt(ctx.catalog_books_count)}\n"
            f"private_books_count_total: {_fmt(ctx.private_books_count_total)}\n"
            f"active_parents_count: {_fmt(ctx.active_parents_count)}\n"
            f"ocr_queued_or_running_jobs: {_fmt(ctx.ocr_queued_running_count)}\n"
            f"ocr_failed_or_retryable_jobs: {_fmt(ctx.ocr_failed_count)}\n"
            "</VERIFIED_ADMIN_OPS_SUMMARY>"
        )

    children_desc = (
        ", ".join(f"{c.alias} (Lớp {c.grade})" for c in ctx.children)
        if ctx.children
        else "none"
    )
    active_desc = (
        f"{ctx.active_child_alias} (Lớp {ctx.active_child_grade})"
        if ctx.active_child_alias is not None and ctx.active_child_grade is not None
        else "none_selected"
    )
    weak_desc = (
        ", ".join(ctx.active_child_weak_words)
        if ctx.active_child_weak_words
        else "none"
    )
    return (
        "<VERIFIED_OWN_ACCOUNT_SUMMARY>\n"
        f"owned_children_count: {ctx.children_count}\n"
        f"owned_children: {children_desc}\n"
        f"active_child: {active_desc}\n"
        f"active_child_sessions_7d: {ctx.active_child_sessions_7d}\n"
        f"active_child_sessions_total: {ctx.active_child_sessions_total}\n"
        f"active_child_weak_words: {weak_desc}\n"
        f"private_books_count: {ctx.private_books_count}\n"
        "</VERIFIED_OWN_ACCOUNT_SUMMARY>"
    )


def _safe_actions(
    candidates: list[tuple[str, str, str]],
    *,
    role_scope: AssistantRoleScope,
    use_en: bool,
) -> list[AssistantQuickAction]:
    out: list[AssistantQuickAction] = []
    for label_vi, label_en, href in candidates:
        if not is_quick_action_href_allowed(href, role_scope):
            continue
        out.append(
            AssistantQuickAction(
                label=label_en if use_en else label_vi,
                href=href,
            )
        )
        if len(out) >= 3:
            break
    return out


def _safe_offer(
    *,
    role_scope: AssistantRoleScope,
    current_path: str,
    href: str,
    label_vi: str,
    label_en: str,
    reason_vi: str,
    reason_en: str,
    requires_child_selection: bool,
    scenario_id: str,
    use_en: bool,
) -> AssistantNavigationOffer | None:
    clean_current = sanitize_scoped_path(current_path, role_scope)
    if clean_current == href or not is_navigation_href_allowed(href, role_scope):
        return None
    return AssistantNavigationOffer(
        label=label_en if use_en else label_vi,
        href=href,
        reason=reason_en if use_en else reason_vi,
        requires_child_selection=requires_child_selection,
        scenario_id=scenario_id,
    )


def format_live_context_reply(
    ctx: LiveAssistantContext,
    *,
    locale: str = "vi",
    current_path: str = "/",
) -> tuple[
    str,
    list[AssistantQuickAction],
    list[str],
    AssistantNavigationOffer | None,
]:
    """Build deterministic, tenant-safe live copilot response with allowlisted links."""
    use_en = not locale.casefold().startswith("vi")

    if ctx.role_scope == "admin":
        def _count_text(val: int | None) -> str:
            if val is not None:
                return str(val)
            return "unavailable" if use_en else "chưa khả dụng"

        if use_en:
            reply = (
                "Live ViRead Operations Summary (aggregate telemetry only):\n"
                f"• Catalog books: {_count_text(ctx.catalog_books_count)} | Private family books: {_count_text(ctx.private_books_count_total)}\n"
                f"• Active parent accounts: {_count_text(ctx.active_parents_count)}\n"
                f"• OCR jobs queued/running: {_count_text(ctx.ocr_queued_running_count)} | OCR jobs failed/retrying: {_count_text(ctx.ocr_failed_count)}\n"
                "Open Admin Tasks (/admin/tasks) or System Health (/admin/health) for live worker diagnostics."
            )
            prompts = [
                "How do I inspect queued OCR jobs in /admin/tasks?",
                "How do I check worker health in /admin/health?",
                "How does the OCR Hard-Sample Radar work?",
            ]
        else:
            reply = (
                "Thống kê vận hành ViRead hiện tại (chỉ số liệu tổng hợp, không kèm thông tin cá nhân):\n"
                f"• Sách thư viện (Catalog): {_count_text(ctx.catalog_books_count)} | Sách gia đình riêng tư: {_count_text(ctx.private_books_count_total)}\n"
                f"• Tài khoản phụ huynh đang hoạt động: {_count_text(ctx.active_parents_count)}\n"
                f"• Tác vụ OCR đang chờ/chạy: {_count_text(ctx.ocr_queued_running_count)} | Tác vụ OCR lỗi/đợi thử lại: {_count_text(ctx.ocr_failed_count)}\n"
                "Mở Tác vụ AI (/admin/tasks) hoặc Vận hành hệ thống (/admin/health) để kiểm tra chi tiết worker."
            )
            prompts = [
                "Theo dõi hàng đợi OCR tại /admin/tasks thế nào?",
                "Kiểm tra sức khỏe worker ở /admin/health?",
                "Radar mẫu OCR khó hoạt động ra sao?",
            ]
        actions = _safe_actions(
            [
                ("Tác vụ Admin", "Admin Tasks", "/admin/tasks"),
                ("Vận hành hệ thống", "System Health", "/admin/health"),
                ("Kho sách Admin", "Admin Books", "/admin/books"),
            ],
            role_scope="admin",
            use_en=use_en,
        )
        offer = _safe_offer(
            role_scope="admin",
            current_path=current_path,
            href="/admin/tasks",
            label_vi="Đi đến Tác vụ AI Quản trị",
            label_en="Go to Admin AI Tasks",
            reason_vi="Xem hàng đợi tác vụ OCR và xử lý sách trên toàn hệ thống.",
            reason_en="Inspect system-wide OCR and book background jobs.",
            requires_child_selection=False,
            scenario_id="admin_task_center_isolation",
            use_en=use_en,
        )
        return reply, actions, prompts, offer

    # Parent live responses (strictly own-account)
    if ctx.intent == "my_private_books":
        if use_en:
            reply = (
                f"You currently have {ctx.private_books_count} private family book(s) in My Books (/my-books).\n"
                "You can scan new paper pages in Book Scanner (/book-scanner) or create a custom story with Family StoryWeaver."
            )
            prompts = [
                "How do I scan a paper book with camera?",
                "How does Family StoryWeaver work?",
                "What should my child read today?",
            ]
        else:
            reply = (
                f"Tài khoản của bạn hiện có {ctx.private_books_count} sách gia đình riêng tư trong Sách của tôi (/my-books).\n"
                "Ba mẹ có thể quét thêm trang sách giấy tại Quét sách (/book-scanner) hoặc sáng tác truyện bằng Family StoryWeaver."
            )
            prompts = [
                "Cách quét sách giấy bằng camera?",
                "Family StoryWeaver hoạt động thế nào?",
                "Hôm nay bé nên đọc gì?",
            ]
        actions = _safe_actions(
            [
                ("Mở Sách của tôi", "Open My Books", "/my-books"),
                ("Quét sách giấy", "Book Scanner", "/book-scanner"),
                ("Trung tâm tác vụ AI", "AI Task Center", "/studio/tasks"),
            ],
            role_scope="parent",
            use_en=use_en,
        )
        offer = _safe_offer(
            role_scope="parent",
            current_path=current_path,
            href="/my-books",
            label_vi="Đi đến Sách của tôi",
            label_en="Go to My Books",
            reason_vi="Xem và đọc lại các cuốn sách riêng của gia đình bạn.",
            reason_en="Open your family's private books.",
            requires_child_selection=False,
            scenario_id="quick_scan_vs_my_books",
            use_en=use_en,
        )
        return reply, actions, prompts, offer

    if ctx.intent == "my_children":
        if ctx.children_count == 0:
            if use_en:
                reply = (
                    "Your account doesn't have any child profiles yet. "
                    "Create a profile in Create Child Profile (/children/new) with your child's name and grade (1–5) to start reading!"
                )
                prompts = [
                    "How do I create a child profile?",
                    "What are the 3 onboarding steps?",
                    "How many private books do I have?",
                ]
            else:
                reply = (
                    "Tài khoản của bạn hiện chưa có hồ sơ bé nào. "
                    "Hãy tạo hồ sơ tại Tạo hồ sơ bé mới (/children/new) theo tên và lớp (1–5) để lưu riêng tiến độ cho bé nhé!"
                )
                prompts = [
                    "Làm sao tạo hồ sơ cho bé?",
                    "3 bước bắt đầu cho ba mẹ mới?",
                    "Tôi có bao nhiêu sách đã tải lên?",
                ]
            actions = _safe_actions(
                [
                    ("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new"),
                    ("Mở Hồ sơ bé", "Child Profiles", "/children"),
                ],
                role_scope="parent",
                use_en=use_en,
            )
            offer = _safe_offer(
                role_scope="parent",
                current_path=current_path,
                href="/children/new",
                label_vi="Đi đến Tạo hồ sơ bé mới",
                label_en="Go to Create Child Profile",
                reason_vi="Tạo hồ sơ đầu tiên để mở khóa buổi đọc và trò chơi cho bé.",
                reason_en="Create your first child profile.",
                requires_child_selection=False,
                scenario_id="new_parent_onboarding",
                use_en=use_en,
            )
            return reply, actions, prompts, offer

        summary_list = ", ".join(
            f"{c.alias} (Lớp {c.grade})" if not use_en else f"{c.alias} (Grade {c.grade})"
            for c in ctx.children
        )
        if use_en:
            reply = (
                f"Your account has {ctx.children_count} child profile(s): {summary_list}.\n"
                f"Private family books: {ctx.private_books_count}. Pick the child profile you want to read with before opening Books or Games."
            )
            prompts = [
                "What should my child read today?",
                "Which words is my child struggling with?",
                "How do multi-child families switch profiles?",
            ]
        else:
            reply = (
                f"Tài khoản của bạn hiện có {ctx.children_count} hồ sơ bé: {summary_list}.\n"
                f"Tủ sách gia đình riêng tư: {ctx.private_books_count} cuốn. Ba mẹ hãy chọn đúng bé trước khi vào Kho sách hoặc Trò chơi nhé."
            )
            prompts = [
                "Hôm nay bé nên đọc gì?",
                "Bé yếu từ nào cần luyện lại?",
                "Cách chuyển đổi giữa các bé?",
            ]
        actions = _safe_actions(
            [
                ("Mở Hồ sơ bé", "Child Profiles", "/children"),
                ("Mở Kho sách", "Browse Books", "/books"),
                ("Xem Tiến bộ", "View Progress", "/reports"),
            ],
            role_scope="parent",
            use_en=use_en,
        )
        offer = _safe_offer(
            role_scope="parent",
            current_path=current_path,
            href="/children",
            label_vi="Đi đến trang Hồ sơ bé",
            label_en="Go to Child Profiles",
            reason_vi="Xem và chọn đúng hồ sơ bé đang học đọc.",
            reason_en="Review and select your active child profile.",
            requires_child_selection=False,
            scenario_id="child_selection_gate_and_switching",
            use_en=use_en,
        )
        return reply, actions, prompts, offer

    # child_weak_words or child_progress
    if ctx.active_child_alias is None:
        if ctx.children_count == 0:
            if use_en:
                reply = (
                    "You don't have a child profile yet, so there is no reading history or weak-word list yet. "
                    "Create a child profile at /children/new to begin!"
                )
            else:
                reply = (
                    "Hiện tài khoản chưa có hồ sơ bé nên chưa có dữ liệu buổi đọc hay từ cần luyện. "
                    "Ba mẹ hãy tạo hồ sơ bé tại /children/new để bắt đầu nhé!"
                )
            actions = _safe_actions(
                [("Tạo hồ sơ bé mới", "Create Child Profile", "/children/new")],
                role_scope="parent",
                use_en=use_en,
            )
            offer = _safe_offer(
                role_scope="parent",
                current_path=current_path,
                href="/children/new",
                label_vi="Đi đến Tạo hồ sơ bé mới",
                label_en="Go to Create Child Profile",
                reason_vi="Tạo hồ sơ cho bé để bắt đầu lưu tiến độ và từ cần luyện.",
                reason_en="Create a child profile to track progress and weak words.",
                requires_child_selection=False,
                scenario_id="new_parent_onboarding",
                use_en=use_en,
            )
        else:
            children_names = ", ".join(
                f"{c.alias} (Lớp {c.grade})" if not use_en else f"{c.alias} (Grade {c.grade})"
                for c in ctx.children
            )
            if use_en:
                reply = (
                    f"You have {ctx.children_count} child profiles ({children_names}). "
                    "Please select a specific child profile in the widget or on /children so I can check that child's exact reading stats and weak words."
                )
            else:
                reply = (
                    f"Gia đình mình có {ctx.children_count} hồ sơ bé ({children_names}). "
                    "Ba mẹ hãy chọn cụ thể một bé ở thanh chọn bé hoặc trang /children để mình xem đúng tiến độ và từ cần luyện của bé đó nhé!"
                )
            actions = _safe_actions(
                [
                    ("Mở Hồ sơ bé", "Child Profiles", "/children"),
                    ("Về Tổng quan", "Dashboard", "/dashboard"),
                ],
                role_scope="parent",
                use_en=use_en,
            )
            offer = _safe_offer(
                role_scope="parent",
                current_path=current_path,
                href="/children",
                label_vi="Đi đến trang Hồ sơ bé",
                label_en="Go to Child Profiles",
                reason_vi="Chọn một bé cụ thể để xem tiến độ và danh sách từ yếu.",
                reason_en="Select a specific child profile first.",
                requires_child_selection=False,
                scenario_id="child_selection_gate_and_switching",
                use_en=use_en,
            )
        prompts = (
            [
                "How many children do I have?",
                "How do I switch between child profiles?",
                "What is the 5-Minute Reading Train?",
            ]
            if use_en
            else [
                "Nhà tôi có mấy hồ sơ bé?",
                "Cách chuyển đổi giữa các bé?",
                "Chuyến Tàu Đọc 5 Phút hoạt động thế nào?",
            ]
        )
        return reply, actions, prompts, offer

    child_label = (
        f"{ctx.active_child_alias} (Grade {ctx.active_child_grade})"
        if use_en
        else f"{ctx.active_child_alias} (Lớp {ctx.active_child_grade})"
    )

    if ctx.intent == "child_weak_words":
        if ctx.active_child_weak_words:
            words_joined = ", ".join(ctx.active_child_weak_words)
            if use_en:
                reply = (
                    f"Active weak words for {child_label}: {words_joined}.\n"
                    "Practice them in Difficult Words (/reports/difficult-words) or reinforce them naturally through Entertainment games (/entertainment)!"
                )
                prompts = [
                    "How does the Entertainment word-loop work?",
                    "What should my child read today?",
                    "How do I set 0.85x speed for slow reading?",
                ]
            else:
                reply = (
                    f"Các từ bé {child_label} đang cần ôn luyện nhiều nhất: {words_joined}.\n"
                    "Ba mẹ có thể cho bé luyện riêng tại Từ cần luyện (/reports/difficult-words) hoặc ôn tự nhiên qua Góc giải trí (/entertainment) nhé!"
                )
                prompts = [
                    "Vòng lặp từ yếu Entertainment hoạt động thế nào?",
                    "Hôm nay bé nên đọc gì?",
                    "Chỉnh tốc độ 0.85x cho bé đọc chậm ở đâu?",
                ]
            actions = _safe_actions(
                [
                    ("Từ cần luyện", "Difficult Words", "/reports/difficult-words"),
                    ("Góc giải trí", "Entertainment", "/entertainment"),
                    ("Chuyến Tàu Đọc 5 Phút", "5-Min Train", "/learning-train"),
                ],
                role_scope="parent",
                use_en=use_en,
            )
            offer = _safe_offer(
                role_scope="parent",
                current_path=current_path,
                href="/reports/difficult-words",
                label_vi="Đi đến Từ cần luyện",
                label_en="Go to Difficult Words",
                reason_vi=f"Ôn lại các từ {ctx.active_child_alias} hay vấp với micro tự động.",
                reason_en=f"Practice {ctx.active_child_alias}'s tricky words.",
                requires_child_selection=False,
                scenario_id="slow_struggling_reader_support",
                use_en=use_en,
            )
        else:
            if use_en:
                reply = (
                    f"{child_label} currently has no active unmastered weak words recorded across recent sessions ({ctx.active_child_sessions_total} total sessions).\n"
                    "Try a new graded book in Books (/books) or the 5-Minute Reading Train (/learning-train) today!"
                )
                prompts = [
                    "What should my child read today?",
                    "How does the 5-Minute Reading Train work?",
                    "Where is Phoneme Garden?",
                ]
            else:
                reply = (
                    f"Bé {child_label} hiện chưa có từ khó nào còn tồn đọng trong các buổi gần đây (tổng {ctx.active_child_sessions_total} buổi đọc).\n"
                    "Hôm nay ba mẹ có thể cho bé thử một cuốn sách mới ở Kho sách (/books) hoặc lên Chuyến Tàu Đọc 5 Phút (/learning-train) nhé!"
                )
                prompts = [
                    "Hôm nay bé nên đọc gì?",
                    "Chuyến Tàu Đọc 5 Phút gồm những toa nào?",
                    "Vườn Âm Vị & Huy hiệu ở đâu?",
                ]
            actions = _safe_actions(
                [
                    ("Chuyến Tàu Đọc 5 Phút", "5-Min Train", "/learning-train"),
                    ("Mở Kho sách", "Browse Books", "/books"),
                ],
                role_scope="parent",
                use_en=use_en,
            )
            offer = _safe_offer(
                role_scope="parent",
                current_path=current_path,
                href="/learning-train",
                label_vi="Đi đến Chuyến Tàu Đọc 5 Phút",
                label_en="Go to 5-Minute Reading Train",
                reason_vi="Luyện nhanh 3 toa đọc 5 phút phù hợp trình độ của bé.",
                reason_en="Start today's 5-minute adaptive reading train.",
                requires_child_selection=True,
                scenario_id="five_minute_learning_train",
                use_en=use_en,
            )
        return reply, actions, prompts, offer

    # child_progress
    weak_note_vi = (
        f" Từ nên ưu tiên ôn: {', '.join(ctx.active_child_weak_words)}."
        if ctx.active_child_weak_words
        else " Chưa có từ khó tồn đọng."
    )
    weak_note_en = (
        f" Priority weak words: {', '.join(ctx.active_child_weak_words)}."
        if ctx.active_child_weak_words
        else " No active unmastered weak words."
    )
    if use_en:
        recommendation = (
            "Start with 5-Minute Reading Train (/learning-train) or Difficult Words (/reports/difficult-words)."
            if ctx.active_child_weak_words
            else "Try a Grade-matched story in Books (/books) or today's 5-Minute Reading Train (/learning-train)."
        )
        reply = (
            f"Recent reading summary for {child_label}:\n"
            f"• Sessions in last 7 days: {ctx.active_child_sessions_7d} | Total sessions: {ctx.active_child_sessions_total}.{weak_note_en}\n"
            f"• Recommended today: {recommendation}"
        )
        prompts = [
            "Which words is my child struggling with?",
            "How do I set weekly email reminders?",
            "Where are Phoneme Garden badges?",
        ]
    else:
        recommendation_vi = (
            "Ưu tiên ôn qua Chuyến Tàu Đọc 5 Phút (/learning-train) hoặc Từ cần luyện (/reports/difficult-words)."
            if ctx.active_child_weak_words
            else "Gợi ý hôm nay: đọc 1 truyện phù hợp lớp tại Kho sách (/books) hoặc chạy Chuyến Tàu Đọc 5 Phút (/learning-train)."
        )
        reply = (
            f"Tổng hợp tiến độ gần đây của bé {child_label}:\n"
            f"• Số buổi đọc 7 ngày qua: {ctx.active_child_sessions_7d} | Tổng số buổi đã đọc: {ctx.active_child_sessions_total}.{weak_note_vi}\n"
            f"• {recommendation_vi}"
        )
        prompts = [
            "Bé yếu từ nào cần luyện?",
            "Cách đặt mục tiêu tuần và nhắc đọc email?",
            "Vườn Âm Vị & Huy hiệu xem ở đâu?",
        ]
    actions = _safe_actions(
        [
            ("Chuyến Tàu Đọc 5 Phút", "5-Min Train", "/learning-train"),
            ("Mở Kho sách", "Browse Books", "/books"),
            ("Báo cáo tiến bộ", "Progress Reports", "/reports"),
        ],
        role_scope="parent",
        use_en=use_en,
    )
    offer = _safe_offer(
        role_scope="parent",
        current_path=current_path,
        href="/learning-train" if ctx.active_child_sessions_7d == 0 or ctx.active_child_weak_words else "/books",
        label_vi="Đi đến Chuyến Tàu Đọc 5 Phút" if ctx.active_child_sessions_7d == 0 or ctx.active_child_weak_words else "Đi đến Kho sách ViRead",
        label_en="Go to 5-Minute Reading Train" if ctx.active_child_sessions_7d == 0 or ctx.active_child_weak_words else "Go to Books Library",
        reason_vi="Bắt đầu nhanh bài luyện đọc hôm nay cho bé.",
        reason_en="Launch today's reading practice for your child.",
        requires_child_selection=True,
        scenario_id="five_minute_learning_train" if ctx.active_child_sessions_7d == 0 or ctx.active_child_weak_words else "books_and_reading_start",
        use_en=use_en,
    )
    return reply, actions, prompts, offer
