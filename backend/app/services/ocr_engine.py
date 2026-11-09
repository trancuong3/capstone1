
def extract_text_and_boxes(image_bytes: bytes) -> dict[str, object]:
    """Chạy quy trình OCR: ưu tiên Dual-Engine, tự động fallback Tesseract cho CI/headless."""
    try:
        paddle_engine, vietocr_engine = _get_ocr_engines()
        return _extract_text_and_boxes_dual_engine(image_bytes, paddle_engine, vietocr_engine)
    except (OcrEngineUnavailable, OcrNoTextDetected):
        return _extract_text_and_boxes_tesseract(image_bytes)
    except Exception:
        try:
            return _extract_text_and_boxes_tesseract(image_bytes)
        except Exception:
            raise
