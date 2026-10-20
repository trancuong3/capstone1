"""Business rules and Admin authorization for book metadata mutations."""
from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.repositories.admin_book_repository import AdminBookRepository
from app.schemas.admin_book import AdminBookWriteRequest
from app.schemas.book import AdminBookMetadataResponse


class AdminBookService:
    def __init__(self, repository: AdminBookRepository):
        self.repository = repository

    async def require_admin(self, actor_id: UUID) -> None:
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")

    async def create(
        self, actor_id: UUID, payload: AdminBookWriteRequest
    ) -> AdminBookMetadataResponse:
        await self.require_admin(actor_id)
        try:
            book = await self.repository.create(
                actor_id=actor_id,
                values=payload.model_dump(),
            )
            return AdminBookMetadataResponse.model_validate(book)
        except SQLAlchemyError:
            raise HTTPException(
                status_code=500,
                detail="Không thể tạo sách lúc này. Vui lòng thử lại.",
            ) from None

    async def update(
        self, actor_id: UUID, book_id: UUID, payload: AdminBookWriteRequest
    ) -> AdminBookMetadataResponse:
        await self.require_admin(actor_id)
        try:
            book = await self.repository.get(book_id)
            if book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            updated = await self.repository.update_metadata(
                book,
                values=payload.model_dump(),
            )
            return AdminBookMetadataResponse.model_validate(updated)
        except HTTPException:
            raise
        except SQLAlchemyError:
            raise HTTPException(
                status_code=500,
                detail="Không thể cập nhật sách lúc này. Vui lòng thử lại.",
            ) from None

    async def update_lifecycle(
        self, actor_id: UUID, book_id: UUID, status: str
    ) -> AdminBookMetadataResponse:
        await self.require_admin(actor_id)
        try:
            book = await self.repository.get(book_id)
            if book is None:
                raise HTTPException(status_code=404, detail="Resource not found")

            if status == "ACTIVE":
                title = book.Title.strip() if isinstance(book.Title, str) else ""
                min_grade = book.MinGrade
                max_grade = book.MaxGrade
                if (
                    not title
                    or not isinstance(min_grade, int)
                    or not isinstance(max_grade, int)
                    or min_grade < 1
                    or min_grade > 5
                    or max_grade < 1
                    or max_grade > 5
                    or min_grade > max_grade
                ):
                    raise HTTPException(
                        status_code=422,
                        detail={
                            "code": "INVALID_BOOK_METADATA",
                            "message": "Hãy sửa tiêu đề và khoảng lớp hợp lệ trước khi kích hoạt sách.",
                        },
                    )

            updated = await self.repository.set_lifecycle(book, status)
            return AdminBookMetadataResponse.model_validate(updated)
        except HTTPException:
            raise
        except SQLAlchemyError:
            raise HTTPException(
                status_code=500,
                detail="Không thể cập nhật trạng thái sách lúc này. Vui lòng thử lại.",
            ) from None
