from fastapi import APIRouter

from app.api.routes import (
    admin_ocr,
    book,
    book_content_quality,
    comprehension,
    parent_private_book,
    profile,
    reading,
    reading_management,
    reading_presence,
    system,
    support,
    voice,
)
from app.api.routes import (
    child_progress,
    picture_description,
    sentence_shooter,
    tutor_question,
    voice_studio,
)
from app.api.routes import admin_viread_training
from app.api.routes import assistant
from app.api.routes import book_assets
from app.api.routes import global_tasks
from app.api.routes import internal_cron
from app.api.routes import internal_ocr
from app.api.routes import karaoke
from app.api.routes import karaoke_processing
from app.api.routes import ocr_extraction

api_router = APIRouter()
api_router.include_router(karaoke.router, prefix="/karaoke", tags=["Karaoke"])
api_router.include_router(karaoke_processing.router, prefix="/karaoke", tags=["Karaoke processing"])

api_router.include_router(profile.router, prefix="/profiles", tags=["Profiles"])
api_router.include_router(parent_private_book.router, prefix="/books", tags=["Parent Private Books"])
api_router.include_router(book.router, prefix="/books", tags=["Books"])
api_router.include_router(admin_ocr.router, prefix="/books", tags=["Admin OCR"])
api_router.include_router(admin_viread_training.router, prefix="/books", tags=["Admin ViOCR Training"])
api_router.include_router(internal_cron.router, prefix="/internal/cron", tags=["Internal Cron"])
api_router.include_router(internal_ocr.router, prefix="/internal/ocr-jobs", tags=["Internal OCR Worker"])
api_router.include_router(reading.router, prefix="/reading", tags=["Reading"])
api_router.include_router(reading_management.router, prefix="/reading-management", tags=["Reading Management"])
api_router.include_router(
    reading_presence.router,
    prefix="/reading-presence",
    tags=["Reading Presence"],
)
api_router.include_router(
    sentence_shooter.router,
    prefix="/games/sentence-shooter",
    tags=["Sentence Shooter"],
)
api_router.include_router(
    picture_description.router,
    prefix="/games/picture-description",
    tags=["Picture Description"],
)
api_router.include_router(comprehension.router, prefix="/comprehension", tags=["Comprehension"])
api_router.include_router(system.router, prefix="/system", tags=["System"])
api_router.include_router(support.router, prefix="/support", tags=["Support"])
api_router.include_router(assistant.router, prefix="/assistant", tags=["Assistant"])
api_router.include_router(voice.router, prefix="/voice", tags=["Voice"])

api_router.include_router(
    book_content_quality.router,
    prefix="/books",
    tags=["Book Content Quality"],
)

api_router.include_router(tutor_question.router, prefix="/tutor", tags=["AI Tutor"])
api_router.include_router(voice_studio.router, prefix="/voice", tags=["Voice"])
api_router.include_router(child_progress.router, prefix="/tutor", tags=["AI Tutor"])
api_router.include_router(ocr_extraction.router, prefix="/studio/ocr", tags=["Smart Book Studio OCR"])
api_router.include_router(book_assets.router, prefix="/studio", tags=["Smart Book Studio Assets"])
api_router.include_router(global_tasks.router, prefix="/studio", tags=["Smart Book Studio Tasks"])
