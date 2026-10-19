from fastapi import APIRouter

from app.api.routes import (
    admin_ocr,
    book,
    comprehension,
    profile,
    reading,
    reading_management,
    system,
    voice,
)

api_router = APIRouter()

api_router.include_router(profile.router, prefix="/profiles", tags=["Profiles"])
api_router.include_router(book.router, prefix="/books", tags=["Books"])
api_router.include_router(admin_ocr.router, prefix="/books", tags=["Admin OCR"])
api_router.include_router(reading.router, prefix="/reading", tags=["Reading"])
api_router.include_router(reading_management.router, prefix="/reading-management", tags=["Reading Management"])
api_router.include_router(comprehension.router, prefix="/comprehension", tags=["Comprehension"])
api_router.include_router(system.router, prefix="/system", tags=["System"])
api_router.include_router(voice.router, prefix="/voice", tags=["Voice"])
