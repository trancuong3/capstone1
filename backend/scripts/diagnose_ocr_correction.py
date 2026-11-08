"""Print effective Admin OCR provider configuration without exposing secrets.

Run from the repository root with ``python backend/scripts/diagnose_ocr_correction.py``.
The script creates no network requests and never prints OCR input or credentials.
"""

from __future__ import annotations

import json
import os
import sys
from importlib.util import find_spec
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

_ENV_NAMES = {
    "cloud_enabled": "OCR_CLOUD_CORRECTION_ENABLED",
    "gemini_key": "GEMINI_API_KEY",
    "groq_key": "GROQ_API_KEY",
    "gemini_primary_model": "GEMINI_OCR_PRIMARY_MODEL",
    "gemini_fallback_model": "GEMINI_OCR_FALLBACK_MODEL",
    "groq_model": "GROQ_OCR_MODEL",
    "local_model": "LOCAL_OCR_MODEL",
}
_PROCESS_VALUES = {
    name: os.environ.get(name) for name in _ENV_NAMES.values()
}

# Importing this module loads the backend, repository, and workspace dotenv files.
from app.database import config as database_config  # noqa: E402
from app.services.ocr_ai.config import OcrCorrectionConfig  # noqa: E402
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator  # noqa: E402


def _source_for(name: str) -> str:
    process_value = _PROCESS_VALUES[name]
    if process_value is not None and process_value.strip():
        return "process environment"

    selected = "default"
    current = process_value
    dotenv_roots = (
        ("backend/.env", database_config.BACKEND_ROOT),
        ("repository/.env", database_config.REPOSITORY_ROOT),
        ("workspace/.env", database_config.WORKSPACE_ROOT),
    )
    from dotenv import dotenv_values

    for label, root in dotenv_roots:
        path = root / ".env"
        if not path.is_file():
            continue
        value = dotenv_values(path).get(name)
        if value is not None and (current is None or not current.strip()):
            current = value
            selected = label
    return selected


def main() -> None:
    config = OcrCorrectionConfig.from_environment()
    orchestrator = OcrCorrectionOrchestrator(config)
    application_spec = find_spec("app.sever")
    report = {
        "python_executable": sys.executable,
        "application_module": (
            str(Path(application_spec.origin).resolve())
            if application_spec and application_spec.origin
            else None
        ),
        "configuration_module": str(Path(database_config.__file__).resolve()),
        "dotenv_files_loaded": [
            str((root / ".env").resolve())
            for root in (
                database_config.BACKEND_ROOT,
                database_config.REPOSITORY_ROOT,
                database_config.WORKSPACE_ROOT,
            )
            if (root / ".env").is_file()
        ],
        "configuration_sources": {
            label: _source_for(name) for label, name in _ENV_NAMES.items()
        },
        "runtime": {
            "cloud_enabled": config.cloud_enabled,
            "gemini_key_configured": bool(config.gemini_api_key),
            "groq_key_configured": bool(config.groq_api_key),
            "gemini_primary_model": config.gemini_primary_model,
            "groq_model": config.groq_model,
            "gemini_fallback_model": config.gemini_fallback_model,
            "local_model": config.local.model,
            "provider_chain": [provider.name for provider in orchestrator.providers],
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
