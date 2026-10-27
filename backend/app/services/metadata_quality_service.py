"""Business rules for the read-only Admin metadata quality dashboard."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException

from app.repositories.metadata_quality_repository import MetadataQualityRepository
from app.schemas.metadata_quality import (
    MetadataQualityBookIssue,
    MetadataQualityIssueType,
    MetadataQualityResponse,
    MetadataQualitySummary,
)


class MetadataQualityService:
    def __init__(self, repository: MetadataQualityRepository):
        self.repository = repository

    async def dashboard(
        self,
        actor_id: UUID,
        *,
        search: str | None,
        issue_type: MetadataQualityIssueType | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> MetadataQualityResponse:
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")

        counts = await self.repository.summary_counts()
        rows, total = await self.repository.list_issues(
            search=search,
            issue_type=issue_type,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        items = []
        for book, has_possible_duplicate in rows:
            issues: list[MetadataQualityIssueType] = []
            title = book.Title
            author = book.Author
            min_grade = book.MinGrade
            max_grade = book.MaxGrade
            if title is None or not str(title).strip():
                issues.append("MISSING_TITLE")
            if author is None or not str(author).strip():
                issues.append("MISSING_AUTHOR")
            if (
                min_grade is None
                or max_grade is None
                or min_grade < 1
                or min_grade > 5
                or max_grade < 1
                or max_grade > 5
                or min_grade > max_grade
            ):
                issues.append("INVALID_GRADE_RANGE")
            if has_possible_duplicate:
                issues.append("POSSIBLE_DUPLICATE")
            items.append(
                MetadataQualityBookIssue(
                    id=book.Id,
                    title=title,
                    author=author,
                    min_grade=min_grade,
                    max_grade=max_grade,
                    lifecycle_status=book.LifecycleStatus,
                    issues=issues,
                )
            )

        summary = MetadataQualitySummary(
            **counts,
            checked_at=datetime.now(timezone.utc),
        )
        return MetadataQualityResponse(
            summary=summary,
            items=items,
            total=total,
            limit=limit,
            offset=offset,
        )
