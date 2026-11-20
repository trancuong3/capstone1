"""Guard the CI contracts that repository branch protection will require.

Uses Python stdlib only, so it runs before npm/pip dependencies are installed.
This validates the checked-out PR workflow files rather than relying on a
possibly stale GitHub UI description. GitHub Ruleset settings remain an
administrator-controlled repository setting, not part of this script.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"

# Real job display names verified against successful GitHub Actions runs.
REQUIRED = {
    "backend-tests.yml": {
        "backend-tests": (
            "Backend unit and API tests",
            ("python scripts/run_ci_tests.py",),
        ),
        "real-ocr-quality": (
            "Real OCR model quality gate",
            ("python scripts/run_real_ocr_gate.py",),
        ),
    },
    "frontend-tests.yml": {
        "frontend-checks": (
            "Frontend tests, typecheck, lint and build",
            ("npm run verify", "npm run build", "npx playwright test"),
        ),
    },
    "admin-book-crud-verification.yml": {
        "frontend-verification": (
            "Frontend format, lint, typecheck, tests, build and E2E",
            (
                "npm run format:check",
                "npm run lint",
                "npm run typecheck",
                "npm test",
                "npm run build",
                "npx playwright test",
            ),
        ),
    },
    "supabase-security-hardening.yml": {
        "supabase-security": (
            "Auth trigger, definer ACL, RLS and profile privilege regression",
            ("supabase/tests/security_hardening_disposable.sql",),
        ),
    },
}


def read_workflow(name: str) -> list[str]:
    return (WORKFLOWS / name).read_text(encoding="utf-8").splitlines()


def indentation(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def yaml_block(lines: list[str], key: str, indent: int) -> list[str]:
    """Extract an exact-indentation YAML mapping block for our fixed CI layout.

    Key lookup is indentation-sensitive; a nested `on` or `if` cannot
    accidentally satisfy a top-level trigger or a job declaration.
    """
    marker = " " * indent + key + ":"
    indices = [
        i
        for i, line in enumerate(lines)
        if line.strip() == marker.strip() and indentation(line) == indent
    ]
    if len(indices) != 1:
        raise AssertionError(
            f"Expected one {key!r} mapping at indentation {indent}; found {len(indices)}"
        )
    start = indices[0] + 1
    end = len(lines)
    for i in range(start, len(lines)):
        line = lines[i]
        if line.strip() and not line.lstrip().startswith("#") and indentation(line) <= indent:
            end = i
            break
    return lines[start:end]


class RequiredCiContractTests(unittest.TestCase):
    def test_all_required_checks_are_unconditional_on_main_pull_requests(self) -> None:
        for workflow in REQUIRED:
            with self.subTest(workflow=workflow):
                lines = read_workflow(workflow)
                events = yaml_block(lines, "on", 0)
                for event in ("pull_request", "push"):
                    block = yaml_block(events, event, 2)
                    self.assertIn("    branches:", block)
                    self.assertIn("      - main", block)
                    self.assertFalse(
                        any(re.match(r"\s+(paths|paths-ignore|types):", line) for line in block),
                        f"{workflow} filters {event}; required checks could be missing",
                    )
                self.assertFalse(
                    any(re.match(r"\s+pull_request_target:", line) for line in events),
                    f"{workflow}: avoid privileged pull_request_target for CI",
                )

    def test_required_job_names_and_fail_closed_steps_cannot_drift(self) -> None:
        displayed_names = set()
        for workflow, jobs in REQUIRED.items():
            lines = read_workflow(workflow)
            job_lines = yaml_block(lines, "jobs", 0)
            for job_id, (name, commands) in jobs.items():
                with self.subTest(workflow=workflow, job=job_id):
                    job = yaml_block(job_lines, job_id, 2)
                    self.assertIn("    name: " + name, job)
                    self.assertNotIn(name, displayed_names, "Duplicate check name")
                    displayed_names.add(name)
                    self.assertFalse(
                        any(re.match(r"^    (if|needs|continue-on-error):", ln) for ln in job),
                        f"{workflow}: required job can be skipped or softened",
                    )
                    source = "\n".join(job)
                    self.assertNotIn("continue-on-error:", source)
                    for command in commands:
                        self.assertIn(command, source, f"{workflow}: missing {command}")

    def test_e2e_full_formatting_is_not_informational(self) -> None:
        job = yaml_block(yaml_block(read_workflow(
            "admin-book-crud-verification.yml"
        ), "jobs", 0), "frontend-verification", 2)
        source = "\n".join(job)
        self.assertIn("- name: Check whole-repository formatting", source)
        self.assertNotIn("continue-on-error:", source)
        self.assertIn("npm run format:check", source)
        self.assertIn("- name: Run end-to-end tests", source)

    def test_optional_path_filtered_ocr_workflow_is_fail_closed(self) -> None:
        # This optional workflow must NOT be configured as a required check:
        # paths-filtered workflows can remain pending for unrelated changes.
        lines = read_workflow("admin-books-ocr-full-verification.yml")
        events = yaml_block(lines, "on", 0)
        self.assertIn("      - \"frontend/**\"", yaml_block(events, "pull_request", 2))
        job = yaml_block(yaml_block(lines, "jobs", 0), "frontend-full", 2)
        source = "\n".join(job)
        self.assertIn("name: Fail if any verification command failed", source)
        self.assertIn("if: always()", source)
        for variable in ("FORMAT", "LINT", "TYPECHECK", "TESTS", "BUILD"):
            self.assertIn(f'test "${variable}" = "success"', source)

    def test_autofix_workflow_never_targets_protected_main(self) -> None:
        lines = read_workflow("format-admin-ocr.yml")
        events = yaml_block(lines, "on", 0)
        push = yaml_block(events, "push", 2)
        self.assertIn("    branches: [feature/admin-book-ocr-integration]", push)
        self.assertNotIn("main", "\n".join(push))
        self.assertNotIn("pull_request:", "\n".join(events))


if __name__ == "__main__":
    unittest.main()
