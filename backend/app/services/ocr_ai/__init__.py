"""Server-side, multimodal OCR-correction providers.

This package deliberately contains no persistence code.  It accepts short-lived
OCR chunks and images from the admin OCR service and returns validated token
suggestions only.
"""

from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator

__all__ = ["OcrCorrectionConfig", "OcrCorrectionOrchestrator"]
