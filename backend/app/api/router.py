from fastapi import APIRouter

from app.api.routes import (
    admin_ocr,
    book,
    book_content_quality,
    comprehension,
    profile,
    reading,
    reading_management,
    system,
    support,
    voice,
)
from app.api.routes import child_progress, tutor_question, voice_studio
from app.api.routes import admin_viread_training

api_router = APIRouter()

api_router.include_router(profile.router, prefix="/profiles", tags=["Profiles"])
api_router.include_router(book.router, prefix="/books", tags=["Books"])
api_router.include_router(admin_ocr.router, prefix="/books", tags=["Admin OCR"])
api_router.include_router(admin_viread_training.router, prefix="/books", tags=["Admin ViOCR Training"])
api_router.include_router(reading.router, prefix="/reading", tags=["Reading"])
api_router.include_router(reading_management.router, prefix="/reading-management", tags=["Reading Management"])
api_router.include_router(comprehension.router, prefix="/comprehension", tags=["Comprehension"])
api_router.include_router(system.router, prefix="/system", tags=["System"])
api_router.include_router(support.router, prefix="/support", tags=["Support"])
api_router.include_router(voice.router, prefix="/voice", tags=["Voice"])

api_router.include_router(
    book_content_quality.router,
    prefix="/books",
    tags=["Book Content Quality"],
)

api_router.include_router(tutor_question.router, prefix="/tutor", tags=["AI Tutor"])
api_router.include_router(voice_studio.router, prefix="/voice", tags=["Voice"])
api_router.include_router(child_progress.router, prefix="/tutor", tags=["AI Tutor"])
