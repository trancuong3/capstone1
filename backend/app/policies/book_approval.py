"""Book release policy shared by assessments, decisions and catalog gates."""

LEGACY_BOOK_APPROVAL_POLICY_VERSIONS = frozenset({"book-children-assessment-v2"})
BOOK_APPROVAL_POLICY_VERSION = "book-children-assessment-v3"
SUPPORTED_BOOK_APPROVAL_POLICY_VERSIONS = (
    LEGACY_BOOK_APPROVAL_POLICY_VERSIONS | {BOOK_APPROVAL_POLICY_VERSION}
)

# Content Usage Rights profiles and explicit Admin review are required for new
# page verifications and book approvals. Legacy published books remain readable
# under LEGACY_BOOK_APPROVAL_POLICY_VERSIONS until re-reviewed without bulk-marking.
COPYRIGHT_BLOCKS_BOOK_APPROVAL = True
AUTO_APPROVAL_ENABLED = False
