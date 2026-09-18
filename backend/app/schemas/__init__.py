# file: backend/app/schemas/__init__.py

from .profile import (
    ProfileCreate, ProfileResponse, 
    ChildProfileCreate, ChildProfileResponse
)
from .book import (
    BookCreate, BookResponse,
    BookPageCreate, BookPageResponse,
    PageRevisionCreate, PageRevisionResponse,
    PageRevisionWordCreate, PageRevisionWordResponse
)
from .reading import (
    ReadingSessionCreate, ReadingSessionResponse,
    ReadingEventCreate, ReadingEventResponse,
    FluencyAssessmentCreate, FluencyAssessmentResponse
)
from .comprehension import (
    ComprehensionQuestionCreate, ComprehensionQuestionResponse,
    ComprehensionAnswerCreate, ComprehensionAnswerResponse
)
from .system import (
    ProgressReportCreate, ProgressReportResponse,
    ConsentRecordCreate, ConsentRecordResponse,
    AuditLogCreate, AuditLogResponse
)