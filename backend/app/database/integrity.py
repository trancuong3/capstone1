"""Safe PostgreSQL integrity-error metadata extraction.

Only server-provided identifiers and SQLSTATE values are returned. Exception
messages, SQL statements and bound parameters are deliberately never inspected.
"""
from __future__ import annotations

import re
from typing import Any

_SQLSTATE_RE = re.compile(r"^[0-9A-Z]{5}$")
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")
_QUALIFIED_IDENTIFIER_RE = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_$]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_$]{0,62})?$"
)
_REPORT_IDEMPOTENCY_CONSTRAINT = "uq_bookcontentreports_reporter_idempotency"


def _exception_candidates(error: BaseException) -> list[Any]:
    pending: list[Any] = [error, getattr(error, "orig", None)]
    candidates: list[Any] = []
    seen: set[int] = set()

    while pending and len(candidates) < 12:
        candidate = pending.pop(0)
        if candidate is None or id(candidate) in seen:
            continue
        seen.add(id(candidate))
        candidates.append(candidate)
        for attribute in ("orig", "__cause__", "__context__"):
            try:
                nested = getattr(candidate, attribute, None)
            except Exception:
                nested = None
            if nested is not None and id(nested) not in seen:
                pending.append(nested)

    return candidates


def _safe_value(value: Any, *, qualified: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    pattern = _QUALIFIED_IDENTIFIER_RE if qualified else _IDENTIFIER_RE
    return value if pattern.fullmatch(value) else None


def postgres_integrity_error_metadata(error: BaseException) -> dict[str, str]:
    """Extract allow-listed SQLSTATE/constraint/table/column metadata only."""
    result: dict[str, str] = {}
    for candidate in _exception_candidates(error):
        try:
            diagnostic = getattr(candidate, "diag", None)
        except Exception:
            diagnostic = None
        for source in (candidate, diagnostic):
            if source is None:
                continue

            if "sqlstate" not in result:
                for attribute in ("sqlstate", "pgcode"):
                    try:
                        value = getattr(source, attribute, None)
                    except Exception:
                        value = None
                    if isinstance(value, str):
                        normalized = value.upper()
                        if _SQLSTATE_RE.fullmatch(normalized):
                            result["sqlstate"] = normalized
                            break

            for key, attribute in (
                ("constraint_name", "constraint_name"),
                ("table_name", "table_name"),
                ("column_name", "column_name"),
            ):
                if key in result:
                    continue
                try:
                    value = getattr(source, attribute, None)
                except Exception:
                    value = None
                safe = _safe_value(value, qualified=(key == "table_name"))
                if safe is not None:
                    result[key] = safe

    return result


def is_book_report_idempotency_violation(error: BaseException) -> bool:
    """Return true only for PostgreSQL's exact report idempotency unique key."""
    metadata = postgres_integrity_error_metadata(error)
    return (
        metadata.get("sqlstate") == "23505"
        and metadata.get("constraint_name") == _REPORT_IDEMPOTENCY_CONSTRAINT
    )
