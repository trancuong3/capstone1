"""Contextual Kids Glossary & PARENT_PRIVATE Vocabulary Notebook service (Feature #6).

Implements:
- Ownership-enforced child profile verification (`child_id` must belong to `parent_id`).
- Grade-differentiated Vietnamese explanations:
  * `GRADE_1_2` (Grades 1–2): ultra-short concrete wording + warm school/family example sentence.
  * `GRADE_3_5` (Grades 3–5): compound (`từ ghép`) / reduplicative (`từ láy`) nuance + expressive example.
- Shared `word_glossary_cache` lookup by `(normalized_word, grade_band)` (zero household PII stored).
- `AiCapabilityRouter` + `child_safety` verification (`ChildSafetyOrchestrator` + deterministic lexical guard)
  with a deterministic safe built-in Vietnamese kid-glossary fallback when AI providers are offline or quota-exhausted.
- Strictly `PARENT_PRIVATE` CRUD on `child_favorite_words` ("Sổ Từ Hay") with duplicate prevention.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
import re
from typing import Any
import unicodedata
from uuid import UUID, uuid4

from fastapi import HTTPException, status
import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, ChildFavoriteWord, ChildProfile, WordGlossaryCache
from app.schemas.vocabulary_notebook import (
    FavoriteWordCreateRequest,
    FavoriteWordDeleteResponse,
    FavoriteWordRead,
    GradeBand,
    VocabularyNotebookListResponse,
    WordExplainRequest,
    WordExplainResponse,
    build_spoken_glossary_tts,
    normalize_glossary_word,
)
from app.services.ai_capability_router import (
    AiCapability,
    AiCapabilityRouter,
    AiErrorKind,
    AiProviderCallError,
    AiRoutingError,
    ProviderSpec,
    build_tenant_cache_key,
    classify_http_error,
)
from app.services.cloud_ai_defaults import (
    extract_gemini_text,
    gemini_thinking_config,
    strip_env_value,
    strip_think_tags,
)
from app.services.ocr_ai.child_safety import ChildSafetyError, ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError

logger = logging.getLogger("viread.kid_glossary")

_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
_PROMPT_VERSION = "feat6-kid-glossary-v1"
_POLICY_VERSION = "grade-1-5-child-safe-v1"

# Deterministic lexical safety blocklist for elementary children (Grades 1–5).
# Prevents explaining inappropriate words or returning unsafe AI output even when safety LLMs are offline.
_UNSAFE_EXACT_TERMS: frozenset[str] = frozenset(
    {
        "ma túy",
        "ma tuy",
        "cần sa",
        "thuốc lá",
        "rượu bia",
        "cờ bạc",
        "cá độ",
        "tự tử",
        "tự sát",
        "tự hại",
        "giết người",
        "đâm chém",
        "chém giết",
        "máu me",
        "bạo lực",
        "hiếp dâm",
        "khiêu dâm",
        "dâm ô",
        "kích dục",
        "khỏa thân",
        "mại dâm",
        "đồ ngu",
        "ngu ngốc",
        "khốn nạn",
        "chết tiệt",
        "đánh đập",
        "tra tấn",
        "khủng bố",
        "súng đạn",
        "bom đạn",
        "sex",
        "porn",
        "xxx",
        "suicide",
        "kill",
        "murder",
        "cocaine",
        "heroin",
    }
)

_UNSAFE_TOKEN_ROOTS: frozenset[str] = frozenset(
    {
        "đụ",
        "địt",
        "lồn",
        "cặc",
        "buồi",
        "đéo",
        "đĩ",
        "chịch",
        "hiếp",
        "dâm",
        "porn",
        "sex",
        "xxx",
    }
)


def contains_unsafe_child_text(value: str | None) -> bool:
    """Fast deterministic Vietnamese + English child-safety lexical guard."""
    if not value:
        return False
    normalized = unicodedata.normalize("NFC", value).casefold()
    collapsed = " ".join(re.findall(r"\w+", normalized, flags=re.UNICODE))
    if not collapsed:
        return False
    padded = f" {collapsed} "
    for phrase in _UNSAFE_EXACT_TERMS:
        if f" {phrase} " in padded:
            return True
    tokens = collapsed.split(" ")
    return any(tok in _UNSAFE_TOKEN_ROOTS for tok in tokens)


def grade_to_band(grade: int) -> GradeBand:
    return "GRADE_1_2" if int(grade) <= 2 else "GRADE_3_5"


@dataclass(frozen=True)
class _GlossaryCandidate:
    part_of_speech_vi: str | None
    definition_vi: str
    example_sentence_vi: str
    nuance_note_vi: str | None


@dataclass(frozen=True)
class _BuiltinGlossaryItem:
    part_of_speech_vi: str
    def_1_2: str
    ex_1_2: str
    def_3_5: str
    ex_3_5: str
    nuance_3_5: str | None = None


# Curated warm Vietnamese elementary dictionary (Grades 1–2 concrete vs Grades 3–5 nuance)
_BUILTIN_VIETNAMESE_KID_GLOSSARY: dict[str, _BuiltinGlossaryItem] = {
    "lung linh": _BuiltinGlossaryItem(
        part_of_speech_vi="từ láy gợi tả",
        def_1_2="Sáng đẹp và rung rinh nhẹ như ánh nến hay ánh sao.",
        ex_1_2="Ánh trăng rằm sáng lung linh trên sân nhà bé.",
        def_3_5="Có ánh sáng đẹp, dịu nhẹ và như đang rung động nhẹ nhàng trước mắt.",
        ex_3_5="Đêm hội Trung thu, những chiếc đèn lồng tỏa sáng lung linh khắp sân trường.",
        nuance_3_5="Từ láy âm đầu «l», gợi vẻ đẹp dịu dàng, huyền ảo của ánh sáng hoặc giọt sương.",
    ),
    "rực rỡ": _BuiltinGlossaryItem(
        part_of_speech_vi="từ láy gợi tả",
        def_1_2="Có màu sắc rất tươi sáng và đẹp mắt.",
        ex_1_2="Vườn hoa trước lớp nở rực rỡ dưới nắng sớm.",
        def_3_5="Có màu sắc hoặc ánh sáng tươi tắn, nổi bật và tràn đầy sức sống.",
        ex_3_5="Bầu trời buổi sáng bừng lên ánh nắng vàng rực rỡ trên hàng phượng vĩ.",
        nuance_3_5="Từ láy âm đầu «r», nhấn mạnh vẻ đẹp tươi sáng, nổi bật và vui tươi.",
    ),
    "chăm chỉ": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ phẩm chất",
        def_1_2="Cố gắng làm việc và học bài đều đặn mỗi ngày.",
        ex_1_2="Bé chăm chỉ luyện đọc từng trang sách cùng mẹ.",
        def_3_5="Siêng năng, kiên trì dành thời gian học tập và giúp đỡ gia đình một cách tự giác.",
        ex_3_5="Nhờ chăm chỉ đọc sách mỗi tối, bạn nhỏ kể chuyện ngày càng tự tin và truyền cảm.",
        nuance_3_5="Từ ghép chỉ đức tính đáng quý của học sinh biết cố gắng bền bỉ.",
    ),
    "dịu dàng": _BuiltinGlossaryItem(
        part_of_speech_vi="từ láy gợi tả",
        def_1_2="Nhẹ nhàng, êm ái làm người nghe thấy ấm lòng.",
        ex_1_2="Mẹ mỉm cười dịu dàng khi nghe bé đọc bài.",
        def_3_5="Êm ái, hiền hòa trong lời nói, cử chỉ hoặc ánh nắng, làn gió nhẹ.",
        ex_3_5="Giọng cô giáo dịu dàng vang lên, hướng dẫn cả lớp đọc từng câu thơ hay.",
        nuance_3_5="Từ láy âm đầu «d», gợi cảm giác hiền hậu, thân thương và bình yên.",
    ),
    "lễ phép": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ phẩm chất",
        def_1_2="Biết chào hỏi và nói lời thưa gửi ngoan ngoãn với người lớn.",
        ex_1_2="Đi học về, bé khoanh tay chào ông bà thật lễ phép.",
        def_3_5="Có thái độ kính trọng, lịch sự trong lời nói và cử chỉ đối với ông bà, cha mẹ, thầy cô.",
        ex_3_5="Bạn Lan luôn lễ phép thưa gửi khi mượn sách ở thư viện nhà trường.",
        nuance_3_5="Từ ghép tổng hợp chỉ nết ngoan trong giao tiếp hằng ngày.",
    ),
    "đoàn kết": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép",
        def_1_2="Cùng thương yêu, giúp đỡ nhau khi học và chơi chung.",
        ex_1_2="Các bạn trong tổ luôn đoàn kết và chia sẻ đồ chơi.",
        def_3_5="Gắn bó chặt chẽ, đồng lòng giúp đỡ nhau để cùng làm tốt công việc chung.",
        ex_3_5="Tập thể lớp 3A luôn đoàn kết giúp nhau tiến bộ trong giờ học nhóm.",
        nuance_3_5="Từ ghép Hán Việt mang sắc thái trang trọng về tinh thần gắn bó tập thể.",
    ),
    "trong xanh": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép miêu tả",
        def_1_2="Có màu xanh sáng, sạch và nhìn rất mát mắt.",
        ex_1_2="Bầu trời mùa thu cao và trong xanh.",
        def_3_5="Xanh dịu, tinh khiết, không gợn mây mù hay bụi bẩn, thường tả bầu trời hoặc mặt hồ.",
        ex_3_5="Buổi sáng cuối tuần, mặt hồ gợn sóng lăn tăn dưới bầu trời trong xanh.",
        nuance_3_5="Từ ghép kết hợp độ trong trẻo và sắc xanh dịu mát của thiên nhiên.",
    ),
    "ríu rít": _BuiltinGlossaryItem(
        part_of_speech_vi="từ láy tượng thanh",
        def_1_2="Tiếng chim hót hoặc tiếng nói cười vui vẻ nối tiếp nhau.",
        ex_1_2="Đàn chim sẻ hót ríu rít trên cành cây bàng.",
        def_3_5="Âm thanh trong trẻo, cao vui vang lên liên tiếp như tiếng chim non hoặc tiếng trò chuyện rộn ràng.",
        ex_3_5="Giờ ra chơi, các bạn học sinh trò chuyện ríu rít dưới bóng cây xanh mát.",
        nuance_3_5="Từ láy âm đầu «r» gợi tả âm thanh vui tươi, nhộn nhịp, đầy sức sống.",
    ),
    "thơm ngát": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép miêu tả",
        def_1_2="Có mùi thơm dễ chịu tỏa ra xung quanh.",
        ex_1_2="Bông hoa nhài trong vườn tỏa hương thơm ngát.",
        def_3_5="Có hương thơm thanh khiết, đậm đà và lan tỏa rộng trong không gian.",
        ex_3_5="Mỗi độ hè về, hương sen thơm ngát theo làn gió mát bay khắp xóm nhỏ.",
        nuance_3_5="Từ ghép phân nghĩa nhấn mạnh hương thơm dịu mát lan tỏa xa.",
    ),
    "dũng cảm": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ phẩm chất",
        def_1_2="Mạnh dạn làm điều đúng và không sợ khó khăn.",
        ex_1_2="Bé dũng cảm nhận lỗi khi lỡ làm rơi quyển vở.",
        def_3_5="Có tinh thần gan dạ, dám đối mặt với thử thách hoặc trung thực nhận lỗi để sửa sai.",
        ex_3_5="Cậu bé trong truyện rất dũng cảm bảo vệ chú chim nhỏ giữa cơn mưa lớn.",
        nuance_3_5="Từ ghép ca ngợi lòng can đảm đi liền với việc làm đúng đắn, nhân hậu.",
    ),
    "hiếu thảo": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ phẩm chất",
        def_1_2="Yêu thương, kính trọng và biết chăm sóc ông bà, cha mẹ.",
        ex_1_2="Bé rót nước mời bà uống như một người cháu hiếu thảo.",
        def_3_5="Hết lòng yêu quý, kính trọng và biết quan tâm, đỡ đần ông bà, cha mẹ bằng tấm lòng biết ơn.",
        ex_3_5="Em luôn cố gắng học giỏi và phụ mẹ việc nhà để làm người con hiếu thảo.",
        nuance_3_5="Từ ghép giàu tình cảm gia đình trong truyền thống văn hóa Việt Nam.",
    ),
    "lấp lánh": _BuiltinGlossaryItem(
        part_of_speech_vi="từ láy gợi tả",
        def_1_2="Ánh sáng nhỏ lóe lên đẹp mắt như giọt nắng trên mặt nước.",
        ex_1_2="Những vì sao lấp lánh trên bầu trời đêm.",
        def_3_5="Phát ra hoặc phản chiếu nhiều tia sáng nhỏ nối tiếp nhau trông rất sinh động.",
        ex_3_5="Nắng sớm chiếu xuống mặt sông làm từng gợn sóng ánh lên lấp lánh như bạc.",
        nuance_3_5="Từ láy âm đầu «l», gợi hình ảnh ánh sáng phản chiếu lấp lóa trên mặt nước hay bầu trời.",
    ),
    "bình minh": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ thời gian",
        def_1_2="Lúc mặt trời mới mọc vào buổi sáng sớm.",
        ex_1_2="Ông mặt trời thức dậy đón bình minh tươi hồng.",
        def_3_5="Khoảnh khắc đầu ngày khi mặt trời vừa nhô lên ở chân trời, mang theo ánh sáng ấm áp.",
        ex_3_5="Khi ánh bình minh vừa hé rạng, tiếng gà gáy vang lên báo hiệu ngày mới bắt đầu.",
        nuance_3_5="Từ ghép Hán Việt giàu chất thơ chỉ buổi sớm mai tươi sáng.",
    ),
    "kiên trì": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ phẩm chất",
        def_1_2="Cố gắng làm đến cùng, chưa giỏi ngay vẫn không bỏ cuộc.",
        ex_1_2="Bé kiên trì đánh vần từng từ khó cho đến khi đọc đúng.",
        def_3_5="Giữ vững quyết tâm rèn luyện đều đặn, gặp việc khó không nản lòng bỏ dở.",
        ex_3_5="Nhờ kiên trì tập viết mỗi ngày, nét chữ của Minh đã trở nên đều và thẳng hàng.",
        nuance_3_5="Từ ghép nhấn mạnh ý chí bền bỉ vượt qua thử thách trong học tập.",
    ),
    "ngập ngừng": _BuiltinGlossaryItem(
        part_of_speech_vi="từ láy gợi tả",
        def_1_2="Hơi dừng lại một chút vì còn rụt rè hoặc đang suy nghĩ.",
        ex_1_2="Lúc đầu bé hơi ngập ngừng, sau đó đã đọc thật to và rõ.",
        def_3_5="Tỏ ra chần chừ, chưa nói hoặc làm ngay vì còn e dè hay đang cân nhắc kỹ.",
        ex_3_5="Bạn nhỏ ngập ngừng giây lát rồi mạnh dạn giơ tay phát biểu ý kiến trước lớp.",
        nuance_3_5="Từ láy âm đầu «ng», diễn tả tinh tế tâm trạng băn khoăn, rụt rè thoáng qua.",
    ),
    "sân trường": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ nơi chốn",
        def_1_2="Khoảng sân rộng ở trường để các bạn tập thể dục và vui chơi.",
        ex_1_2="Giờ ra chơi, sân trường rộn ràng tiếng cười của chúng em.",
        def_3_5="Khoảng không gian rộng thoáng trước các dãy lớp học, nơi diễn ra lễ chào cờ và hoạt động tập thể.",
        ex_3_5="Hàng cây bàng tỏa bóng râm mát rượi xuống khắp khoảng sân trường thân thương.",
        nuance_3_5="Từ ghép chính phụ gọi tên không gian gắn bó thân thiết với tuổi học trò.",
    ),
    "yêu thương": _BuiltinGlossaryItem(
        part_of_speech_vi="từ ghép chỉ tình cảm",
        def_1_2="Quý mến và luôn quan tâm, chăm sóc cho nhau.",
        ex_1_2="Cả nhà bé luôn yêu thương và quây quần bên nhau.",
        def_3_5="Dành tình cảm gắn bó ấm áp, biết sẻ chia và mong muốn điều tốt đẹp cho người thân, bạn bè.",
        ex_3_5="Tình yêu thương của cha mẹ và thầy cô giúp em thêm vững bước mỗi ngày đến lớp.",
        nuance_3_5="Từ ghép đẳng lập kết hợp hai sắc thái quý mến và trân trọng dịu dàng.",
    ),
}

_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["definition_vi", "example_sentence_vi"],
    "properties": {
        "part_of_speech_vi": {"type": "string"},
        "definition_vi": {"type": "string"},
        "example_sentence_vi": {"type": "string"},
        "nuance_note_vi": {"type": "string"},
    },
}


def _detect_reduplicative_or_compound_hint(display_word: str) -> tuple[str, str | None]:
    """Infer kid-friendly Vietnamese lexical structure note for multi-syllable words."""
    syllables = [tok for tok in display_word.split(" ") if tok]
    if len(syllables) == 1:
        return "từ đơn", None
    if len(syllables) == 2:
        s1 = syllables[0].casefold()
        s2 = syllables[1].casefold()
        if s1 == s2:
            return (
                "từ láy toàn bộ",
                f"Từ láy lặp lại tiếng «{syllables[0]}» giúp câu văn sinh động và giàu nhịp điệu hơn.",
            )
        onset_re = re.compile(r"^(ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdđghklmnpqrstvx])", re.UNICODE)
        m1 = onset_re.match(s1)
        m2 = onset_re.match(s2)
        if m1 and m2 and m1.group(1) == m2.group(1):
            return (
                "từ ghép / từ láy",
                f"Từ hai tiếng có cùng âm đầu «{m1.group(1)}», giúp lời kể chuyện mềm mại và giàu hình ảnh.",
            )
        return (
            "từ hai tiếng",
            f"Từ hai tiếng kết hợp «{syllables[0]}» và «{syllables[1]}» để diễn tả ý nghĩa rõ ràng, cụ thể hơn.",
        )
    return (
        "cụm từ",
        "Cụm từ nhiều tiếng giúp bé miêu tả sự vật, hoạt động hoặc cảm xúc trọn vẹn hơn khi kể chuyện.",
    )


def build_deterministic_kid_glossary(
    display_word: str,
    normalized_word: str,
    grade_band: GradeBand,
) -> _GlossaryCandidate:
    """Safe offline deterministic Vietnamese kid glossary & example sentence generator."""
    curated = _BUILTIN_VIETNAMESE_KID_GLOSSARY.get(normalized_word)
    if curated is not None:
        if grade_band == "GRADE_1_2":
            return _GlossaryCandidate(
                part_of_speech_vi=curated.part_of_speech_vi,
                definition_vi=curated.def_1_2,
                example_sentence_vi=curated.ex_1_2,
                nuance_note_vi=None,
            )
        return _GlossaryCandidate(
            part_of_speech_vi=curated.part_of_speech_vi,
            definition_vi=curated.def_3_5,
            example_sentence_vi=curated.ex_3_5,
            nuance_note_vi=curated.nuance_3_5,
        )

    pos_vi, nuance_vi = _detect_reduplicative_or_compound_hint(display_word)
    if grade_band == "GRADE_1_2":
        return _GlossaryCandidate(
            part_of_speech_vi=pos_vi,
            definition_vi=f"Từ «{display_word}» giúp bé gọi tên hoặc tả sự vật, hoạt động quen thuộc trong bài đọc.",
            example_sentence_vi=f"Bé đọc to từ «{display_word}» thật rõ ràng cùng gia đình ở nhà.",
            nuance_note_vi=None,
        )
    return _GlossaryCandidate(
        part_of_speech_vi=pos_vi,
        definition_vi=(
            f"Từ «{display_word}» dùng trong câu văn tiếng Việt để làm rõ hình ảnh, hoạt động hoặc phẩm chất đang được nhắc tới."
        ),
        example_sentence_vi=(
            f"Trong giờ Tập đọc ở lớp, em đã dùng từ «{display_word}» để đặt một câu kể chuyện thật hay."
        ),
        nuance_note_vi=nuance_vi,
    )


def _system_prompt_for_grade_band(grade_band: GradeBand) -> str:
    if grade_band == "GRADE_1_2":
        return (
            "Bạn là giáo viên Tiểu học Việt Nam ấm áp đang giải nghĩa từ cho học sinh Lớp 1–2 (6–7 tuổi).\n"
            "QUY TẮC BẮT BUỘC:\n"
            "1. Trả về ĐÚNG 1 JSON object theo schema: {\"part_of_speech_vi\", \"definition_vi\", \"example_sentence_vi\", \"nuance_note_vi\"}.\n"
            "2. \"definition_vi\": CỰC NGẮN GỌN, cụ thể, dễ hình dung ngay cho bé 6–7 tuổi (1 câu ngắn tối đa 22 chữ, dùng từ ngữ đời thường).\n"
            "3. \"example_sentence_vi\": 1 câu ví dụ tiếng Việt ấm áp, trong sáng về gia đình, trường lớp hoặc thiên nhiên có chứa từ đó.\n"
            "4. Tuyệt đối an toàn cho trẻ em Tiểu học: không bạo lực, không hù dọa, không từ nhạy cảm hay người lớn."
        )
    return (
        "Bạn là giáo viên Tiếng Việt Tiểu học đang giải nghĩa từ vựng cho học sinh Lớp 3–5 (8–10 tuổi).\n"
        "QUY TẮC BẮT BUỘC:\n"
        "1. Trả về ĐÚNG 1 JSON object theo schema: {\"part_of_speech_vi\", \"definition_vi\", \"example_sentence_vi\", \"nuance_note_vi\"}.\n"
        "2. \"definition_vi\": Giải thích rõ ràng, giàu hình ảnh trong 1–2 câu gọn gàng phù hợp học sinh Lớp 3–5.\n"
        "3. \"nuance_note_vi\": Nêu ngắn gọn sắc thái biểu cảm (ví dụ từ ghép, từ láy gợi tả âm thanh/hình ảnh, hoặc cách dùng hay khi kể chuyện).\n"
        "4. \"example_sentence_vi\": 1 câu văn tiếng Việt sinh động, ấm áp về trường học, gia đình hoặc thiên nhiên có sử dụng từ này.\n"
        "5. Tuyệt đối an toàn cho trẻ em Tiểu học: không bạo lực, không hù dọa, không nội dung nhạy cảm."
    )


def _clean_sentence(raw: object, *, max_chars: int = 260) -> str:
    if not isinstance(raw, str):
        return ""
    cleaned = unicodedata.normalize("NFC", raw).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned[:max_chars].strip()
    if cleaned and cleaned[-1] not in ".!?":
        cleaned = f"{cleaned}."
    return cleaned


def _decode_json_dict(raw_text: str | None) -> dict[str, Any] | None:
    cleaned = strip_think_tags(raw_text or "").strip()
    if not cleaned:
        return None
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()
    try:
        parsed = json.loads(cleaned)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


SafetyCheckerFn = Callable[[str], Awaitable[Mapping[str, Any]]]


class KidGlossaryService:
    """Service for Feature #6 Contextual Kids Dictionary & PARENT_PRIVATE Vocabulary Notebook."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        ai_router: AiCapabilityRouter | None = None,
        safety_checker: SafetyCheckerFn | ChildSafetyOrchestrator | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self.db = db
        self._env: Mapping[str, str] = os.environ if env is None else env
        self._router = ai_router or AiCapabilityRouter(env=env)
        self._safety_checker = safety_checker
        self._transport = transport

    async def _verify_child_ownership(self, parent_id: UUID, child_id: UUID) -> tuple[UUID, int]:
        """Ensure `child_id` exists and strictly belongs to the authenticated `parent_id`."""
        result = await self.db.execute(
            select(ChildProfile).where(ChildProfile.Id == child_id)
        )
        child = result.scalar_one_or_none()
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        if child.ParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            )
        grade_int = max(1, min(5, int(child.Grade or 1)))
        return child.Id, grade_int

    async def _find_saved_notebook_item(
        self,
        *,
        parent_id: UUID,
        child_id: UUID,
        normalized_word: str,
    ) -> ChildFavoriteWord | None:
        result = await self.db.execute(
            select(ChildFavoriteWord).where(
                ChildFavoriteWord.ChildProfileId == child_id,
                ChildFavoriteWord.NormalizedWord == normalized_word,
            )
        )
        row = result.scalar_one_or_none()
        if row is not None and row.ParentId != parent_id:
            return None
        return row

    async def _verify_text_child_safe(self, provider_id: str, text_to_check: str) -> None:
        """Enforce both deterministic lexical guard and `child_safety` LLM check when configured."""
        if contains_unsafe_child_text(text_to_check):
            raise AiProviderCallError(
                provider_id=provider_id,
                kind=AiErrorKind.UNSAFE_OUTPUT,
                code="CHILD_SAFETY_LEXICAL_REJECTED",
            )

        verdict: Mapping[str, Any] | None = None
        if self._safety_checker is not None:
            try:
                if isinstance(self._safety_checker, ChildSafetyOrchestrator):
                    verdict = await self._safety_checker.analyze(text_to_check)
                else:
                    verdict = await self._safety_checker(text_to_check)
            except (ChildSafetyError, OcrConfigurationError):
                verdict = None
        else:
            try:
                cfg = OcrCorrectionConfig.from_environment()
                if cfg.gemini_enabled or cfg.groq_enabled or cfg.local_enabled:
                    orchestrator = ChildSafetyOrchestrator(cfg, transport=self._transport)
                    verdict = await orchestrator.analyze(text_to_check)
            except (ChildSafetyError, OcrConfigurationError):
                verdict = None

        if verdict is not None:
            suitability = str(verdict.get("suitability") or "SUITABLE").upper()
            findings = verdict.get("findings") or []
            has_blocking_finding = any(
                isinstance(f, Mapping)
                and str(f.get("severity") or "").upper() in {"MEDIUM", "HIGH"}
                for f in findings
            )
            if suitability in {"REVIEW_REQUIRED", "NOT_RECOMMENDED"} or has_blocking_finding:
                raise AiProviderCallError(
                    provider_id=provider_id,
                    kind=AiErrorKind.UNSAFE_OUTPUT,
                    code="CHILD_SAFETY_REJECTED",
                )

    async def _invoke_glossary_provider(
        self,
        provider: ProviderSpec,
        timeout_seconds: float,
        *,
        display_word: str,
        grade_band: GradeBand,
        safe_context: str | None,
    ) -> _GlossaryCandidate:
        system_prompt = _system_prompt_for_grade_band(grade_band)
        user_lines = [f'Từ cần giải nghĩa: "{display_word}"']
        if safe_context:
            user_lines.append(f'Câu ngữ cảnh đang đọc: "{safe_context}"')
        user_prompt = "\n".join(user_lines)

        decoded: dict[str, Any] | None = None
        if provider.family == "google":
            api_key = strip_env_value(self._env.get("GEMINI_API_KEY"))
            if not api_key:
                raise AiProviderCallError(
                    provider_id=provider.provider_id,
                    kind=AiErrorKind.AUTH_FAILURE,
                    code="GEMINI_API_KEY_MISSING",
                )
            gen_cfg: dict[str, Any] = {
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseJsonSchema": _RESPONSE_SCHEMA,
            }
            thinking_cfg = gemini_thinking_config(provider.model_id)
            if thinking_cfg is not None:
                gen_cfg["thinkingConfig"] = thinking_cfg
            payload = {
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                "generationConfig": gen_cfg,
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                resp = await client.post(
                    f"{_GEMINI_API_BASE}/models/{provider.model_id}:generateContent",
                    headers={"x-goog-api-key": api_key},
                    json=payload,
                )
            if resp.status_code != 200:
                raise classify_http_error(
                    provider_id=provider.provider_id,
                    status_code=resp.status_code,
                    body_text=resp.text[:512],
                    retry_after_header=resp.headers.get("retry-after"),
                )
            decoded = _decode_json_dict(extract_gemini_text(resp.json()))

        elif provider.family == "groq":
            api_key = strip_env_value(self._env.get("GROQ_API_KEY"))
            if not api_key:
                raise AiProviderCallError(
                    provider_id=provider.provider_id,
                    kind=AiErrorKind.AUTH_FAILURE,
                    code="GROQ_API_KEY_MISSING",
                )
            schema_text = json.dumps(_RESPONSE_SCHEMA, ensure_ascii=False)
            payload = {
                "model": provider.model_id,
                "temperature": 0.2,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": f"{system_prompt}\nJSON Schema:\n{schema_text}"},
                    {"role": "user", "content": user_prompt},
                ],
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                resp = await client.post(
                    _GROQ_CHAT_URL,
                    headers={"Authorization": f"Bearer {api_key}"},
                    json=payload,
                )
            if resp.status_code != 200:
                raise classify_http_error(
                    provider_id=provider.provider_id,
                    status_code=resp.status_code,
                    body_text=resp.text[:512],
                    retry_after_header=resp.headers.get("retry-after"),
                )
            data = resp.json()
            content = (
                data.get("choices", [{}])[0].get("message", {}).get("content")
                if isinstance(data, dict)
                else None
            )
            decoded = _decode_json_dict(content if isinstance(content, str) else None)

        elif provider.family == "ollama":
            base_url = (
                strip_env_value(self._env.get("LOCAL_OCR_BASE_URL"))
                or "http://127.0.0.1:11434"
            ).rstrip("/")
            payload = {
                "model": provider.model_id,
                "stream": False,
                "format": "json",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            }
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                resp = await client.post(f"{base_url}/api/chat", json=payload)
            if resp.status_code != 200:
                raise classify_http_error(
                    provider_id=provider.provider_id,
                    status_code=resp.status_code,
                    body_text=resp.text[:512],
                )
            data = resp.json()
            content = data.get("message", {}).get("content") if isinstance(data, dict) else None
            decoded = _decode_json_dict(content if isinstance(content, str) else None)

        else:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
                code="UNSUPPORTED_GLOSSARY_PROVIDER_FAMILY",
            )

        if decoded is None:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="INVALID_GLOSSARY_JSON",
            )

        definition_vi = _clean_sentence(
            decoded.get("definition_vi"),
            max_chars=180 if grade_band == "GRADE_1_2" else 280,
        )
        example_vi = _clean_sentence(decoded.get("example_sentence_vi"), max_chars=240)
        nuance_vi_raw = _clean_sentence(decoded.get("nuance_note_vi"), max_chars=220)
        nuance_vi = nuance_vi_raw if (nuance_vi_raw and grade_band == "GRADE_3_5") else None
        pos_raw = str(decoded.get("part_of_speech_vi") or "").strip()
        pos_vi = unicodedata.normalize("NFC", pos_raw)[:48] if pos_raw else None

        if len(definition_vi) < 6 or len(example_vi) < 6:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="EMPTY_GLOSSARY_FIELDS",
            )

        combined_for_safety = " ".join(
            part for part in (definition_vi, example_vi, nuance_vi or "", pos_vi or "") if part
        )
        await self._verify_text_child_safe(provider.provider_id, combined_for_safety)

        return _GlossaryCandidate(
            part_of_speech_vi=pos_vi,
            definition_vi=definition_vi,
            example_sentence_vi=example_vi,
            nuance_note_vi=nuance_vi,
        )

    async def explain_word(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: WordExplainRequest,
    ) -> WordExplainResponse:
        """Explain a Vietnamese word tailored to the child's grade band with cache + safety + fallback."""
        _, child_grade = await self._verify_child_ownership(parent_id, child_id)
        try:
            display_word, normalized_word = normalize_glossary_word(payload.word)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(exc),
            ) from None

        if contains_unsafe_child_text(normalized_word):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="WORD_NOT_SUITABLE_FOR_CHILDREN",
            )

        effective_grade = payload.grade_override if payload.grade_override is not None else child_grade
        grade_band = grade_to_band(effective_grade)
        safe_context = (
            None
            if contains_unsafe_child_text(payload.context_sentence)
            else payload.context_sentence
        )

        # 1. Check saved state in child's PARENT_PRIVATE notebook + shared glossary cache.
        saved_row = await self._find_saved_notebook_item(
            parent_id=parent_id,
            child_id=child_id,
            normalized_word=normalized_word,
        )
        is_saved = saved_row is not None
        saved_item_id = saved_row.Id if saved_row is not None else None

        cache_stmt = select(WordGlossaryCache).where(
            WordGlossaryCache.NormalizedWord == normalized_word,
            WordGlossaryCache.GradeBand == grade_band,
        )
        cached_row = (await self.db.execute(cache_stmt)).scalar_one_or_none()
        if cached_row is not None:
            cached_def = str(cached_row.DefinitionVi)
            cached_ex = str(cached_row.ExampleSentenceVi)
            cached_nuance = str(cached_row.NuanceNoteVi) if cached_row.NuanceNoteVi else None
            cached_pos = str(cached_row.PartOfSpeechVi) if cached_row.PartOfSpeechVi else None
            if not contains_unsafe_child_text(f"{cached_def} {cached_ex} {cached_nuance or ''}"):
                return WordExplainResponse(
                    word=display_word,
                    normalized_word=normalized_word,
                    grade_band=grade_band,
                    part_of_speech_vi=cached_pos,
                    definition_vi=cached_def,
                    example_sentence_vi=cached_ex,
                    nuance_note_vi=cached_nuance,
                    spoken_tts_text=build_spoken_glossary_tts(
                        display_word,
                        cached_def,
                        cached_ex,
                        cached_nuance,
                    ),
                    source_provider="CACHE",
                    cached=True,
                    fallback_used=False,
                    safety_checked=True,
                    is_saved_in_notebook=is_saved,
                    notebook_item_id=saved_item_id,
                )

        # Release read transaction BEFORE outbound HTTP AI / safety calls (backend invariant #11).
        await self.db.rollback()

        # 2. Route through AiCapabilityRouter + child_safety verification.
        tenant_scope = f"parent:{parent_id}"
        source_hash = hashlib.sha256(
            f"{normalized_word}|{grade_band}|{safe_context or ''}".encode("utf-8")
        ).hexdigest()
        router_cache_key = build_tenant_cache_key(
            source_hash=source_hash,
            revision="v1",
            model_version="kid-glossary-auto",
            prompt_version=_PROMPT_VERSION,
            algorithm_version="feat6-v1",
            policy_version=_POLICY_VERSION,
            tenant_scope=tenant_scope,
            capability=AiCapability.TEXT_ANALYSIS,
        )

        candidate: _GlossaryCandidate | None = None
        provider_label = "FALLBACK"
        router_cached = False
        fallback_used = False

        try:
            routed = await self._router.route_and_execute(
                AiCapability.TEXT_ANALYSIS,
                lambda spec, timeout_s: self._invoke_glossary_provider(
                    spec,
                    timeout_s,
                    display_word=display_word,
                    grade_band=grade_band,
                    safe_context=safe_context,
                ),
                total_budget_seconds=10.0,
                cache_key=router_cache_key,
                tenant_scope=tenant_scope,
                fail_closed_on_unsafe=True,
            )
            candidate = routed.value
            provider_label = routed.provider_id
            router_cached = routed.cached
        except AiRoutingError as exc:
            logger.info(
                "kid_glossary_ai_fallback kind=%s code=%s grade_band=%s",
                exc.kind.value,
                exc.code,
                grade_band,
            )
            fallback_used = True
            provider_label = (
                "FALLBACK_SAFE"
                if exc.kind == AiErrorKind.UNSAFE_OUTPUT
                else "FALLBACK"
            )
            candidate = build_deterministic_kid_glossary(
                display_word,
                normalized_word,
                grade_band,
            )

        # 3. Persist safe, context-independent AI definitions to shared `word_glossary_cache`
        #    (NEVER cache private context-influenced outputs or fallback placeholders).
        if not fallback_used and safe_context is None and candidate is not None:
            now = datetime.now(timezone.utc)
            cache_entry = WordGlossaryCache(
                Id=uuid4(),
                NormalizedWord=normalized_word,
                DisplayWord=display_word,
                GradeBand=grade_band,
                PartOfSpeechVi=candidate.part_of_speech_vi,
                DefinitionVi=candidate.definition_vi,
                ExampleSentenceVi=candidate.example_sentence_vi,
                NuanceNoteVi=candidate.nuance_note_vi,
                SourceProvider=provider_label,
                SafetySuitability="SUITABLE",
                CreatedAt=now,
                UpdatedAt=now,
            )
            self.db.add(cache_entry)
            try:
                await self.db.commit()
            except IntegrityError:
                await self.db.rollback()

        return WordExplainResponse(
            word=display_word,
            normalized_word=normalized_word,
            grade_band=grade_band,
            part_of_speech_vi=candidate.part_of_speech_vi,
            definition_vi=candidate.definition_vi,
            example_sentence_vi=candidate.example_sentence_vi,
            nuance_note_vi=candidate.nuance_note_vi,
            spoken_tts_text=build_spoken_glossary_tts(
                display_word,
                candidate.definition_vi,
                candidate.example_sentence_vi,
                candidate.nuance_note_vi,
            ),
            source_provider=provider_label,
            cached=router_cached,
            fallback_used=fallback_used,
            safety_checked=True,
            is_saved_in_notebook=is_saved,
            notebook_item_id=saved_item_id,
        )

    @staticmethod
    def _to_favorite_word_read(
        row: ChildFavoriteWord,
        *,
        already_saved: bool = False,
    ) -> FavoriteWordRead:
        word = str(row.Word)
        definition_vi = str(row.DefinitionVi)
        example_vi = str(row.ExampleSentenceVi)
        nuance_vi = str(row.NuanceNoteVi) if row.NuanceNoteVi else None
        grade_band: GradeBand = (
            "GRADE_3_5" if str(row.GradeBand) == "GRADE_3_5" else "GRADE_1_2"
        )
        now = datetime.now(timezone.utc)
        return FavoriteWordRead(
            id=row.Id,
            child_profile_id=row.ChildProfileId,
            word=word,
            normalized_word=str(row.NormalizedWord),
            grade_band=grade_band,
            definition_vi=definition_vi,
            example_sentence_vi=example_vi,
            nuance_note_vi=nuance_vi,
            spoken_tts_text=build_spoken_glossary_tts(
                word,
                definition_vi,
                example_vi,
                nuance_vi,
            ),
            source_book_id=row.SourceBookId,
            source_page_id=row.SourcePageId,
            visibility="PARENT_PRIVATE",
            times_used_in_games=int(row.TimesUsedInGames or 0),
            already_saved=already_saved,
            created_at=row.CreatedAt or now,
            updated_at=row.UpdatedAt or now,
        )

    async def list_notebook(
        self,
        parent_id: UUID,
        child_id: UUID,
        *,
        limit: int = 50,
    ) -> VocabularyNotebookListResponse:
        """List a child's PARENT_PRIVATE saved words + up to 3 bonus storytelling words for games."""
        await self._verify_child_ownership(parent_id, child_id)
        safe_limit = max(1, min(200, int(limit)))
        stmt = (
            select(ChildFavoriteWord)
            .where(
                ChildFavoriteWord.ChildProfileId == child_id,
                ChildFavoriteWord.ParentId == parent_id,
            )
            .order_by(ChildFavoriteWord.CreatedAt.desc())
        )
        rows = list((await self.db.execute(stmt)).scalars().all())
        visible_rows = rows[:safe_limit]

        # Prioritize least-practiced-in-games then newest saved words (up to 3) as storytelling bonus prompts.
        ranked_for_story = sorted(
            rows,
            key=lambda r: (
                int(r.TimesUsedInGames or 0),
                -(r.CreatedAt.timestamp() if getattr(r, "CreatedAt", None) else 0.0),
            ),
        )
        storytelling_words: list[str] = []
        seen_norm: set[str] = set()
        for r in ranked_for_story:
            norm = str(r.NormalizedWord)
            if norm in seen_norm:
                continue
            seen_norm.add(norm)
            storytelling_words.append(str(r.Word))
            if len(storytelling_words) >= 3:
                break

        return VocabularyNotebookListResponse(
            child_id=child_id,
            total=len(rows),
            storytelling_words=storytelling_words,
            items=[self._to_favorite_word_read(r) for r in visible_rows],
        )

    async def _validate_optional_book_source(
        self,
        parent_id: UUID,
        source_book_id: UUID | None,
        source_page_id: UUID | None,
    ) -> tuple[UUID | None, UUID | None]:
        """Prevent cross-parent private book probing when attaching optional reading provenance."""
        resolved_book_id = source_book_id
        resolved_page_id = source_page_id

        if resolved_book_id is not None:
            book = (
                await self.db.execute(select(Book).where(Book.Id == resolved_book_id))
            ).scalar_one_or_none()
            if book is None or getattr(book, "IsDeleted", False):
                resolved_book_id = None
                resolved_page_id = None
            elif (
                str(getattr(book, "VisibilityScope", "CATALOG")) == "PARENT_PRIVATE"
                and getattr(book, "OwnerParentId", None) != parent_id
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied",
                )

        if resolved_page_id is not None:
            page = (
                await self.db.execute(select(BookPage).where(BookPage.Id == resolved_page_id))
            ).scalar_one_or_none()
            if page is None:
                resolved_page_id = None
            elif resolved_book_id is not None and page.BookId != resolved_book_id:
                resolved_page_id = None
            elif resolved_book_id is None:
                book = (
                    await self.db.execute(select(Book).where(Book.Id == page.BookId))
                ).scalar_one_or_none()
                if book is None or getattr(book, "IsDeleted", False):
                    resolved_page_id = None
                elif (
                    str(getattr(book, "VisibilityScope", "CATALOG")) == "PARENT_PRIVATE"
                    and getattr(book, "OwnerParentId", None) != parent_id
                ):
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Access denied",
                    )
                else:
                    resolved_book_id = book.Id

        return resolved_book_id, resolved_page_id

    async def save_to_notebook(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: FavoriteWordCreateRequest,
    ) -> tuple[FavoriteWordRead, bool]:
        """Save a favorite word to a child's PARENT_PRIVATE notebook with duplicate prevention.

        Returns `(favorite_word_read, created_new)`.
        """
        _, child_grade = await self._verify_child_ownership(parent_id, child_id)
        try:
            display_word, normalized_word = normalize_glossary_word(payload.word)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(exc),
            ) from None

        if contains_unsafe_child_text(normalized_word):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="WORD_NOT_SUITABLE_FOR_CHILDREN",
            )

        existing = await self._find_saved_notebook_item(
            parent_id=parent_id,
            child_id=child_id,
            normalized_word=normalized_word,
        )
        if existing is not None:
            return self._to_favorite_word_read(existing, already_saved=True), False

        resolved_book_id, resolved_page_id = await self._validate_optional_book_source(
            parent_id,
            payload.source_book_id,
            payload.source_page_id,
        )

        grade_band: GradeBand = payload.grade_band or grade_to_band(child_grade)
        provided_def = _clean_sentence(payload.definition_vi, max_chars=320)
        provided_ex = _clean_sentence(payload.example_sentence_vi, max_chars=320)
        provided_nuance = _clean_sentence(payload.nuance_note_vi, max_chars=240) or None

        if contains_unsafe_child_text(f"{provided_def} {provided_ex} {provided_nuance or ''}"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="CONTENT_NOT_SUITABLE_FOR_CHILDREN",
            )

        if not provided_def or not provided_ex:
            cached_row = (
                await self.db.execute(
                    select(WordGlossaryCache).where(
                        WordGlossaryCache.NormalizedWord == normalized_word,
                        WordGlossaryCache.GradeBand == grade_band,
                    )
                )
            ).scalar_one_or_none()
            if cached_row is not None:
                provided_def = provided_def or str(cached_row.DefinitionVi)
                provided_ex = provided_ex or str(cached_row.ExampleSentenceVi)
                if provided_nuance is None and cached_row.NuanceNoteVi:
                    provided_nuance = str(cached_row.NuanceNoteVi)
            else:
                builtin = build_deterministic_kid_glossary(
                    display_word,
                    normalized_word,
                    grade_band,
                )
                provided_def = provided_def or builtin.definition_vi
                provided_ex = provided_ex or builtin.example_sentence_vi
                if provided_nuance is None:
                    provided_nuance = builtin.nuance_note_vi

        now = datetime.now(timezone.utc)
        new_row = ChildFavoriteWord(
            Id=uuid4(),
            ChildProfileId=child_id,
            ParentId=parent_id,
            Word=display_word,
            NormalizedWord=normalized_word,
            GradeBand=grade_band,
            DefinitionVi=provided_def,
            ExampleSentenceVi=provided_ex,
            NuanceNoteVi=provided_nuance,
            SourceBookId=resolved_book_id,
            SourcePageId=resolved_page_id,
            Visibility="PARENT_PRIVATE",
            TimesUsedInGames=0,
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(new_row)
        try:
            await self.db.commit()
        except IntegrityError:
            await self.db.rollback()
            raced = await self._find_saved_notebook_item(
                parent_id=parent_id,
                child_id=child_id,
                normalized_word=normalized_word,
            )
            if raced is not None:
                return self._to_favorite_word_read(raced, already_saved=True), False
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="DUPLICATE_FAVORITE_WORD",
            ) from None

        return self._to_favorite_word_read(new_row, already_saved=False), True

    async def delete_from_notebook(
        self,
        parent_id: UUID,
        child_id: UUID,
        item_id: UUID,
    ) -> FavoriteWordDeleteResponse:
        """Delete a saved word from a child's PARENT_PRIVATE notebook."""
        await self._verify_child_ownership(parent_id, child_id)
        row = (
            await self.db.execute(
                select(ChildFavoriteWord).where(ChildFavoriteWord.Id == item_id)
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Favorite word not found",
            )
        if row.ParentId != parent_id or row.ChildProfileId != child_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            )
        await self.db.delete(row)
        await self.db.commit()
        return FavoriteWordDeleteResponse(deleted=True, item_id=item_id)
