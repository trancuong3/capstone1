from .profile import Profile, ChildProfile
from .karaoke import KaraokeSong, KaraokeSongVersion
from .karaoke_processing import KaraokeProcessingJob, KaraokeProcessingOperation
from .book import Book, BookPage, PageRevision, PageRevisionWord
from .reading import ReadingSession, ReadingSessionPage, ReadingEvent, FluencyAssessment
from .comprehension import ComprehensionQuestion, ComprehensionAnswer
from .system import ProgressReport, ConsentRecord, AuditLog
from .reading_management import ReadingGoal, ReadingPlan, ChildBookCollection, ReadingReminder, ReadingReminderOccurrence
from app.models.reading_comparison_report import ReadingComparisonReport

from app.models.book_content_quality import (
    BookContentReport,
    BookContentReportHistory,
    BookQualityFinding,
    BookQualityPageScan,
    BookQualityReportFinding,
    BookQualityScanRun,
    BookRightsEvidence,
    BookRightsEvidenceHistory,
)

from .game_session import GameAttempt, GameRound, GameSession
from .picture_description import PictureDescriptionAttempt, PictureDescriptionSession
from .admin_ai_workflow import AdminAiWorkflow
from .difficult_word_practice import DifficultWordPracticeAttempt
