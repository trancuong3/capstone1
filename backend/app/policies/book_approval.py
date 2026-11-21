"""Book release policy shared by assessments, decisions and catalog gates."""

BOOK_APPROVAL_POLICY_VERSION = "book-children-assessment-v3"
LEGACY_BOOK_APPROVAL_POLICY_VERSION = "book-children-assessment-v2"
SUPPORTED_BOOK_APPROVAL_POLICY_VERSIONS = (
    BOOK_APPROVAL_POLICY_VERSION,
    LEGACY_BOOK_APPROVAL_POLICY_VERSION,
)

# Rights/usage-permission evidence review is optional/advisory for now.
# Page verification and book approval require OCR, Proofreading, Text Child
# Safety, and Image Safety without blocking on missing rights evidence.
COPYRIGHT_BLOCKS_BOOK_APPROVAL = False
