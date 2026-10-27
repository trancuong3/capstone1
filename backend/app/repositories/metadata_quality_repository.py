"""Read-only PostgreSQL queries for Admin book metadata quality reporting."""
from __future__ import annotations

from sqlalchemy import case, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models import Book, Profile


class MetadataQualityRepository:
    """Persistence-only queries for catalog metadata quality."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id):
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id)
        )

    @staticmethod
    def _trim_whitespace(value):
        # PostgreSQL trim() removes ordinary spaces only. POSIX [[:space:]]
        # also handles tabs/newlines so whitespace-only metadata is not missed.
        return func.regexp_replace(
            value,
            r"^[[:space:]]+|[[:space:]]+$",
            "",
            "g",
        )

    @classmethod
    def _normalized_title(cls, book):
        return func.lower(cls._trim_whitespace(func.coalesce(book.Title, "")))

    @classmethod
    def _normalized_author(cls, book):
        return func.lower(cls._trim_whitespace(func.coalesce(book.Author, "")))

    @classmethod
    def _possible_duplicate(cls):
        other = aliased(Book)
        current_title = cls._normalized_title(Book)
        other_title = cls._normalized_title(other)
        current_author = cls._normalized_author(Book)
        other_author = cls._normalized_author(other)
        return exists(
            select(1)
            .select_from(other)
            .where(
                other.Id != Book.Id,
                func.length(current_title) > 0,
                func.length(other_title) > 0,
                func.length(current_author) > 0,
                func.length(other_author) > 0,
                current_title == other_title,
                current_author == other_author,
            )
        )

    @classmethod
    def _issue_conditions(cls):
        return {
            "MISSING_TITLE": func.length(
                cls._trim_whitespace(func.coalesce(Book.Title, ""))
            ) == 0,
            "MISSING_AUTHOR": func.length(
                cls._trim_whitespace(func.coalesce(Book.Author, ""))
            ) == 0,
            "INVALID_GRADE_RANGE": or_(
                Book.MinGrade.is_(None),
                Book.MaxGrade.is_(None),
                Book.MinGrade < 1,
                Book.MinGrade > 5,
                Book.MaxGrade < 1,
                Book.MaxGrade > 5,
                Book.MinGrade > Book.MaxGrade,
            ),
            "POSSIBLE_DUPLICATE": cls._possible_duplicate(),
        }

    @staticmethod
    def _search_pattern(value: str) -> str:
        escaped = value.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return "%" + escaped + "%"

    async def summary_counts(self) -> dict[str, int]:
        issues = self._issue_conditions()
        any_issue = or_(*issues.values())
        statement = select(
            func.count(Book.Id).label("total_books"),
            func.count(case((issues["MISSING_TITLE"], Book.Id))).label("missing_title"),
            func.count(case((issues["MISSING_AUTHOR"], Book.Id))).label("missing_author"),
            func.count(case((issues["INVALID_GRADE_RANGE"], Book.Id))).label("invalid_grade_range"),
            func.count(case((issues["POSSIBLE_DUPLICATE"], Book.Id))).label("books_in_duplicate_groups"),
            func.count(case((any_issue, Book.Id))).label("books_with_issues"),
        ).select_from(Book)
        row = (await self.db.execute(statement)).one()

        normalized_title = self._normalized_title(Book)
        normalized_author = self._normalized_author(Book)
        duplicate_groups = (
            select(
                normalized_title.label("normalized_title"),
                normalized_author.label("normalized_author"),
            )
            .where(
                func.length(normalized_title) > 0,
                func.length(normalized_author) > 0,
            )
            .group_by(normalized_title, normalized_author)
            .having(func.count(Book.Id) > 1)
            .subquery()
        )
        group_count = await self.db.scalar(
            select(func.count()).select_from(duplicate_groups)
        )
        return {
            "total_books": int(row.total_books or 0),
            "books_with_issues": int(row.books_with_issues or 0),
            "missing_title": int(row.missing_title or 0),
            "missing_author": int(row.missing_author or 0),
            "invalid_grade_range": int(row.invalid_grade_range or 0),
            "possible_duplicate_groups": int(group_count or 0),
            "books_in_duplicate_groups": int(row.books_in_duplicate_groups or 0),
        }

    def _filters(
        self,
        *,
        search: str | None,
        issue_type: str | None,
        lifecycle_status: str | None,
    ):
        conditions = self._issue_conditions()
        filters = [
            conditions[issue_type] if issue_type else or_(*conditions.values())
        ]
        if search and search.strip():
            pattern = self._search_pattern(search)
            filters.append(
                or_(
                    Book.Title.ilike(pattern, escape="\\"),
                    Book.Author.ilike(pattern, escape="\\"),
                )
            )
        if lifecycle_status:
            filters.append(Book.LifecycleStatus == lifecycle_status)
        return conditions, filters

    async def list_issues(
        self,
        *,
        search: str | None,
        issue_type: str | None,
        lifecycle_status: str | None,
        offset: int,
        limit: int,
    ):
        conditions, filters = self._filters(
            search=search,
            issue_type=issue_type,
            lifecycle_status=lifecycle_status,
        )
        statement = (
            select(Book, conditions["POSSIBLE_DUPLICATE"].label("has_possible_duplicate"))
            .where(*filters)
            .order_by(func.lower(func.trim(func.coalesce(Book.Title, ""))), Book.Id)
            .offset(offset)
            .limit(limit)
        )
        result = await self.db.execute(statement)
        items = [
            (row[0], bool(row[1]))
            for row in result.all()
        ]

        total = await self.db.scalar(
            select(func.count(Book.Id)).where(*filters)
        )
        return items, int(total or 0)
