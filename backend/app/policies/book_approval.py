"""Book release policy shared by assessments, decisions and catalog gates."""

BOOK_APPROVAL_POLICY_VERSION = "book-children-assessment-v3"
LEGACY_BOOK_APPROVAL_POLICY_VERSION = "book-children-assessment-v2"

# Rights/usage-permission evidence review is persisted per book/page and blocks
# new book approvals when missing, insufficient, flagged, or stale.
COPYRIGHT_BLOCKS_BOOK_APPROVAL = True
