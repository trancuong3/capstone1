from __future__ import annotations

import json

from app.services.admin_ocr_chunking import OcrTextChunk


SYSTEM_PROMPT = """Bạn là hệ thống chuyên kiểm tra và sửa lỗi nhận dạng văn bản OCR tiếng Việt trong sách dành cho trẻ em.

Đối chiếu trực tiếp SOURCE OCR TEXT với SOURCE PAGE IMAGE. IMAGE là bằng chứng trực quan; SOURCE OCR TEXT là dữ liệu gốc. Chỉ sửa lỗi có bằng chứng rõ ràng từ ảnh và ngữ cảnh.

Quy tắc bắt buộc:
1. Kiểm tra từng token tiếng Việt, gồm dấu thanh, ă/â/ê/ô/ơ/ư và d/đ.
2. Không viết lại câu, thêm/bỏ/tách/gộp token, đổi thứ tự token, khoảng trắng, xuống dòng hay dấu câu.
3. Không đổi tên riêng, lời thoại, phương ngữ, từ tượng thanh hoặc cách diễn đạt nghệ thuật nếu ảnh không chứng minh là lỗi OCR.
4. Nếu ảnh mờ hoặc không chắc chắn, giữ nguyên token đó và ghi chỉ số của nó vào uncertain_word_indices.
5. Việc giữ nguyên toàn bộ token là một kết quả hợp lệ.

Chỉ trả về JSON đúng schema. Không Markdown, không lời chào, không giải thích và không trả toàn bộ trang."""


def chunk_prompt(chunk: OcrTextChunk) -> str:
    source_words = [{"index": token.index, "text": token.text} for token in chunk.tokens]
    return (
        f"CHUNK_ID: {chunk.chunk_id}\n"
        "PREVIOUS CONTEXT (read-only):\n"
        f"{chunk.previous_context}\n"
        "SOURCE OCR TEXT (target chunk):\n"
        f"{chunk.target_text}\n"
        "NEXT CONTEXT (read-only):\n"
        f"{chunk.next_context}\n"
        "SOURCE WORDS JSON (only these words may be returned, in this order):\n"
        f"{json.dumps(source_words, ensure_ascii=False, separators=(',', ':'))}"
    )


def response_json_schema(word_count: int) -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["chunk_id", "corrected_words", "uncertain_word_indices"],
        "properties": {
            "chunk_id": {"type": "integer"},
            "corrected_words": {
                "type": "array",
                "minItems": word_count,
                "maxItems": word_count,
                "items": {"type": "string", "minLength": 1, "maxLength": 500},
            },
            "uncertain_word_indices": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": word_count - 1},
            },
        },
    }
