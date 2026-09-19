from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
from pydantic import UUID4

from app.api.deps import get_db
from app.models import Book, BookPage
from app.schemas import BookResponse, BookCreate, BookPageResponse

router = APIRouter()

@router.get("/", response_model=List[BookResponse])
async def get_books(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách tất cả các đầu sách trong hệ thống"""
    result = await db.execute(select(Book))
    return result.scalars().all()

@router.post("/", response_model=BookResponse)
async def create_book(book_in: BookCreate, db: AsyncSession = Depends(get_db)):
    """Thêm một đầu sách mới"""
    new_book = Book(**book_in.model_dump())
    db.add(new_book)
    await db.commit()
    await db.refresh(new_book)
    return new_book

@router.get("/{book_id}/pages", response_model=List[BookPageResponse])
async def get_book_pages(book_id: UUID4, db: AsyncSession = Depends(get_db)):
    """Lấy danh sách các trang của một quyển sách cụ thể"""
    query = select(BookPage).where(BookPage.BookId == book_id).order_by(BookPage.PageNumber)
    result = await db.execute(query)
    return result.scalars().all()