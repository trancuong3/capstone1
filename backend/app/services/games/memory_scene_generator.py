from __future__ import annotations

import hashlib
import random
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from app.schemas.memory_game import (
    CanonicalColorVi,
    ColorShapeCue,
    GradeRecommendationRead,
    MemoryThemeRead,
    MemoryThemesCatalogRead,
    ObjectHintTiers,
    PositionZone,
    SceneBackdropSpec,
    SceneBBox,
    SceneObjectSpec,
    SceneSpec,
    ThemeKey,
    TimerMode,
    TimerOptionRead,
)

LayerKind = Literal["sky", "mid", "ground"]


@dataclass(frozen=True, slots=True)
class ColorPaletteItem:
    color_vi: CanonicalColorVi
    hex_code: str
    stroke_hex: str
    light_hex: str
    shape_cue: ColorShapeCue
    aliases_vi: tuple[str, ...]


CANONICAL_COLORS: tuple[ColorPaletteItem, ...] = (
    ColorPaletteItem(
        color_vi="đỏ",
        hex_code="#D63031",
        stroke_hex="#8E1B1B",
        light_hex="#FF8A8A",
        shape_cue="circle",
        aliases_vi=("đỏ", "đỏ tươi", "màu đỏ", "đỏ thắm"),
    ),
    ColorPaletteItem(
        color_vi="xanh dương",
        hex_code="#1D63D8",
        stroke_hex="#0F3C8A",
        light_hex="#7CB4FF",
        shape_cue="square",
        aliases_vi=("xanh dương", "xanh biển", "xanh lam", "xanh da trời", "màu xanh dương"),
    ),
    ColorPaletteItem(
        color_vi="vàng",
        hex_code="#E09F00",
        stroke_hex="#8C5E00",
        light_hex="#FFE074",
        shape_cue="star",
        aliases_vi=("vàng", "vàng tươi", "vàng rực", "màu vàng", "vàng óng"),
    ),
    ColorPaletteItem(
        color_vi="xanh lá",
        hex_code="#1F8A4C",
        stroke_hex="#11522C",
        light_hex="#73DC9D",
        shape_cue="triangle",
        aliases_vi=("xanh lá", "xanh lá cây", "xanh lục", "màu xanh lá"),
    ),
    ColorPaletteItem(
        color_vi="cam",
        hex_code="#E56B1F",
        stroke_hex="#993E08",
        light_hex="#FFAF75",
        shape_cue="diamond",
        aliases_vi=("cam", "màu cam", "da cam", "cam tươi"),
    ),
    ColorPaletteItem(
        color_vi="tím",
        hex_code="#7B3FE4",
        stroke_hex="#4B1E99",
        light_hex="#C4A5FF",
        shape_cue="hexagon",
        aliases_vi=("tím", "màu tím", "tím nhạt", "tím đậm"),
    ),
)

COLOR_BY_VI: dict[CanonicalColorVi, ColorPaletteItem] = {
    item.color_vi: item for item in CANONICAL_COLORS
}


@dataclass(frozen=True, slots=True)
class SpriteDefinition:
    sprite_key: str
    theme_key: ThemeKey
    name_vi: str
    category_vi: str
    aliases_vi: tuple[str, ...]
    action_vi: str
    preferred_layer: LayerKind
    allowed_colors: tuple[CanonicalColorVi, ...]
    supports_plural: bool = True
    focus_keywords: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ThemeDefinition:
    theme_key: ThemeKey
    name_vi: str
    description_vi: str
    badge_vi: str
    backdrop: SceneBackdropSpec
    creative_prompt_vi: str


@dataclass(frozen=True, slots=True)
class LayoutSlot:
    slot_id: int
    layer: LayerKind
    position_zone: PositionZone
    x: float
    y: float
    w: float
    h: float


# 9 strictly disjoint slots inside [0.04..0.96] x [0.07..0.93].
# Minimum horizontal separation >= 0.055 and vertical separation >= 0.055 before tiny <=0.01 jitter,
# mathematically guaranteeing 0% bounding-box overlap for every seed and grade 1-5.
LAYOUT_SLOTS: tuple[LayoutSlot, ...] = (
    LayoutSlot(0, "sky", "trên trái", 0.05, 0.08, 0.24, 0.22),
    LayoutSlot(1, "sky", "giữa", 0.38, 0.08, 0.24, 0.22),
    LayoutSlot(2, "sky", "trên phải", 0.71, 0.08, 0.24, 0.22),
    LayoutSlot(3, "mid", "trên trái", 0.05, 0.39, 0.24, 0.22),
    LayoutSlot(4, "mid", "giữa", 0.38, 0.39, 0.24, 0.22),
    LayoutSlot(5, "mid", "trên phải", 0.71, 0.39, 0.24, 0.22),
    LayoutSlot(6, "ground", "dưới trái", 0.05, 0.70, 0.24, 0.22),
    LayoutSlot(7, "ground", "giữa", 0.38, 0.70, 0.24, 0.22),
    LayoutSlot(8, "ground", "dưới phải", 0.71, 0.70, 0.24, 0.22),
)


THEMES: tuple[ThemeDefinition, ...] = (
    ThemeDefinition(
        theme_key="sunny_garden",
        name_vi="Khu vườn nắng mai",
        description_vi="Khu vườn rực rỡ nắng sớm với mèo mướp, cánh diều, bướm xinh và hoa hướng dương.",
        badge_vi="Thiên nhiên",
        backdrop=SceneBackdropSpec(
            theme_key="sunny_garden",
            sky_top_hex="#BCE8FF",
            sky_bottom_hex="#FFF8D9",
            horizon_hex="#A4E48E",
            ground_hex="#73C66A",
            accent_hex="#F7B731",
            mood_vi="Nắng sớm dịu nhẹ, bầu trời trong xanh",
        ),
        creative_prompt_vi="Nếu khu vườn nắng mai tiếp tục câu chuyện, các bạn nhỏ và con vật trong vườn sẽ làm gì tiếp theo?",
    ),
    ThemeDefinition(
        theme_key="happy_classroom",
        name_vi="Lớp học vui vẻ",
        description_vi="Góc lớp học thân thương với bảng xanh, sách mở, quả địa cầu, cặp sách và máy bay giấy.",
        badge_vi="Trường học",
        backdrop=SceneBackdropSpec(
            theme_key="happy_classroom",
            sky_top_hex="#FFF7E2",
            sky_bottom_hex="#FDECC8",
            horizon_hex="#1E6B52",
            ground_hex="#DFB88C",
            accent_hex="#087467",
            mood_vi="Phòng học sáng sủa, ấm áp và ngăn nắp",
        ),
        creative_prompt_vi="Khi tiếng trống ra chơi vang lên, những đồ vật đáng yêu trong lớp học này sẽ có cuộc phiêu lưu gì nhỉ?",
    ),
    ThemeDefinition(
        theme_key="mid_autumn_yard",
        name_vi="Sân đình Trung thu",
        description_vi="Đêm rằm sáng trăng với đèn ông sao, trống cơm, bánh trung thu, thỏ ngọc và đầu lân.",
        badge_vi="Lễ hội Việt",
        backdrop=SceneBackdropSpec(
            theme_key="mid_autumn_yard",
            sky_top_hex="#1D3263",
            sky_bottom_hex="#3A5998",
            horizon_hex="#B55B3C",
            ground_hex="#D9A36C",
            accent_hex="#FFCA3A",
            mood_vi="Đêm trăng tròn ấm áp, rực rỡ sắc màu lễ hội",
        ),
        creative_prompt_vi="Dưới ánh trăng rằm sáng tỏ, chuyện gì vui sẽ xảy ra ở sân đình Trung thu tiếp theo?",
    ),
    ThemeDefinition(
        theme_key="seaside_morning",
        name_vi="Biển sớm quê em",
        description_vi="Bãi biển sáng sớm mát lành với thuyền buồm, chim hải âu, sao biển, lâu đài cát và phao bơi.",
        badge_vi="Biển đảo",
        backdrop=SceneBackdropSpec(
            theme_key="seaside_morning",
            sky_top_hex="#FFE2BE",
            sky_bottom_hex="#BEE9FF",
            horizon_hex="#3B9AE1",
            ground_hex="#F7DC98",
            accent_hex="#1D63D8",
            mood_vi="Gió biển mát rượi, sóng vỗ nhẹ trên bãi cát vàng",
        ),
        creative_prompt_vi="Khi sóng biển vỗ nhẹ vào bờ cát, chiếc thuyền buồm và các bạn ở bãi biển sẽ đi khám phá đâu tiếp theo?",
    ),
    ThemeDefinition(
        theme_key="countryside_pond",
        name_vi="Ao sen làng quê",
        description_vi="Ao sen yên bình quê hương với hoa sen, chú ếch, chuồn chuồn, vịt con, nón lá và thuyền nan.",
        badge_vi="Làng quê",
        backdrop=SceneBackdropSpec(
            theme_key="countryside_pond",
            sky_top_hex="#D4F2FF",
            sky_bottom_hex="#F8FCEB",
            horizon_hex="#47B2A0",
            ground_hex="#8FD17A",
            accent_hex="#1F8A4C",
            mood_vi="Bình yên bên lũy tre xanh và mặt ao sen trong mát",
        ),
        creative_prompt_vi="Trên mặt ao sen lấp lánh, chú ếch, vịt con và các bạn nhỏ quanh ao sẽ cùng làm gì tiếp theo?",
    ),
    ThemeDefinition(
        theme_key="friendly_market",
        name_vi="Góc chợ tuổi thơ",
        description_vi="Góc chợ quê rộn ràng với dưa hấu, nải chuối, giỏ mây, heo đất, chong chóng và bánh chưng.",
        badge_vi="Đời sống",
        backdrop=SceneBackdropSpec(
            theme_key="friendly_market",
            sky_top_hex="#FFF1D6",
            sky_bottom_hex="#FFE3BA",
            horizon_hex="#D96B43",
            ground_hex="#E2D3BC",
            accent_hex="#E56B1F",
            mood_vi="Góc chợ sáng rộn ràng, thân thiện và đầy sắc màu",
        ),
        creative_prompt_vi="Nếu bé được đi dạo ở góc chợ tuổi thơ này, chuyện thú vị gì sẽ xảy ra tiếp theo?",
    ),
)

THEME_BY_KEY: dict[ThemeKey, ThemeDefinition] = {item.theme_key: item for item in THEMES}
THEME_KEYS: tuple[ThemeKey, ...] = tuple(item.theme_key for item in THEMES)

ALL_COLOR_KEYS: tuple[CanonicalColorVi, ...] = (
    "đỏ",
    "xanh dương",
    "vàng",
    "xanh lá",
    "cam",
    "tím",
)

# 42 distinct kid-friendly vector sprites (7 per theme — exceeds 36+ requirement)
SPRITE_CATALOG: tuple[SpriteDefinition, ...] = (
    # --- 1. sunny_garden (7) ---
    SpriteDefinition(
        sprite_key="tabby_cat",
        theme_key="sunny_garden",
        name_vi="mèo mướp",
        category_vi="con vật dễ thương",
        aliases_vi=("mèo", "con mèo", "chú mèo", "mèo con", "bé mèo", "mèo mướp"),
        action_vi="đang vẫy đuôi sưởi nắng",
        preferred_layer="ground",
        allowed_colors=("cam", "vàng", "tím", "xanh dương"),
        focus_keywords=("mèo", "mướp", "vườn", "nắng"),
    ),
    SpriteDefinition(
        sprite_key="butterfly",
        theme_key="sunny_garden",
        name_vi="bướm xinh",
        category_vi="côn trùng bay lượn",
        aliases_vi=("bướm", "con bướm", "bươm bướm", "chú bướm", "bướm xinh"),
        action_vi="đang bay lượn nhẹ nhàng",
        preferred_layer="sky",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("bướm", "bươm bướm", "bay", "cánh"),
    ),
    SpriteDefinition(
        sprite_key="sunflower",
        theme_key="sunny_garden",
        name_vi="hoa hướng dương",
        category_vi="loài hoa trong vườn",
        aliases_vi=("hoa", "bông hoa", "hướng dương", "hoa hướng dương", "đóa hoa"),
        action_vi="đang nở rực rỡ đón nắng",
        preferred_layer="mid",
        allowed_colors=("vàng", "cam", "đỏ", "tím"),
        focus_keywords=("hoa", "hướng dương", "nở", "vườn"),
    ),
    SpriteDefinition(
        sprite_key="watering_can",
        theme_key="sunny_garden",
        name_vi="bình tưới cây",
        category_vi="đồ dùng làm vườn",
        aliases_vi=("bình tưới", "bình tưới cây", "bình nước", "ấm tưới", "cái bình"),
        action_vi="đang nằm sẵn sàng tưới hoa",
        preferred_layer="ground",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("bình", "tưới", "cây", "nước"),
    ),
    SpriteDefinition(
        sprite_key="paper_kite",
        theme_key="sunny_garden",
        name_vi="diều giấy",
        category_vi="đồ chơi bay trên trời",
        aliases_vi=("diều", "con diều", "cánh diều", "diều giấy"),
        action_vi="đang bay cao đón gió",
        preferred_layer="sky",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("diều", "giấy", "gió", "trời"),
    ),
    SpriteDefinition(
        sprite_key="singing_bird",
        theme_key="sunny_garden",
        name_vi="chim sẻ",
        category_vi="loài chim nhỏ",
        aliases_vi=("chim", "con chim", "chú chim", "chim sẻ", "chim nhỏ"),
        action_vi="đang hót líu lo vui vẻ",
        preferred_layer="sky",
        allowed_colors=("xanh dương", "vàng", "đỏ", "cam", "xanh lá"),
        focus_keywords=("chim", "sẻ", "hót", "líu lo"),
    ),
    SpriteDefinition(
        sprite_key="garden_ball",
        theme_key="sunny_garden",
        name_vi="quả bóng",
        category_vi="đồ chơi hình tròn",
        aliases_vi=("bóng", "quả bóng", "trái bóng", "quả banh", "banh"),
        action_vi="đang lăn trên thảm cỏ",
        preferred_layer="ground",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("bóng", "quả bóng", "chơi", "lăn"),
    ),
    # --- 2. happy_classroom (7) ---
    SpriteDefinition(
        sprite_key="open_book",
        theme_key="happy_classroom",
        name_vi="quyển sách",
        category_vi="đồ dùng học tập",
        aliases_vi=("sách", "quyển sách", "cuốn sách", "quyển vở", "vở"),
        action_vi="đang mở rộng những trang chữ mới",
        preferred_layer="ground",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("sách", "đọc", "trang", "vở", "học"),
    ),
    SpriteDefinition(
        sprite_key="pencil_cup",
        theme_key="happy_classroom",
        name_vi="bút chì",
        category_vi="đồ dùng viết vẽ",
        aliases_vi=("bút", "bút chì", "cây bút", "hộp bút", "bút màu", "viết chì"),
        action_vi="đang ngay ngắn chờ bé viết bài",
        preferred_layer="mid",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("bút", "chì", "viết", "vẽ"),
    ),
    SpriteDefinition(
        sprite_key="school_bag",
        theme_key="happy_classroom",
        name_vi="cặp sách",
        category_vi="đồ dùng mang sách vở",
        aliases_vi=("cặp", "cặp sách", "cái cặp", "ba lô", "balo", "túi sách"),
        action_vi="đang đặt gọn gàng cạnh bàn học",
        preferred_layer="ground",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("cặp", "sách", "ba lô", "lớp"),
    ),
    SpriteDefinition(
        sprite_key="world_globe",
        theme_key="happy_classroom",
        name_vi="quả địa cầu",
        category_vi="đồ dùng khám phá thế giới",
        aliases_vi=("địa cầu", "quả địa cầu", "quả cầu", "bản đồ tròn"),
        action_vi="đang đặt trên kệ học tập",
        preferred_layer="mid",
        allowed_colors=("xanh dương", "xanh lá", "cam", "tím"),
        supports_plural=False,
        focus_keywords=("địa cầu", "thế giới", "trái đất"),
    ),
    SpriteDefinition(
        sprite_key="wall_clock",
        theme_key="happy_classroom",
        name_vi="đồng hồ",
        category_vi="đồ vật xem giờ",
        aliases_vi=("đồng hồ", "cái đồng hồ", "chiếc đồng hồ", "đồng hồ treo tường"),
        action_vi="đang tích tắc báo giờ học",
        preferred_layer="sky",
        allowed_colors=ALL_COLOR_KEYS,
        supports_plural=False,
        focus_keywords=("đồng hồ", "giờ", "tích tắc"),
    ),
    SpriteDefinition(
        sprite_key="paper_plane",
        theme_key="happy_classroom",
        name_vi="máy bay giấy",
        category_vi="đồ chơi gấp giấy",
        aliases_vi=("máy bay", "máy bay giấy", "chiếc máy bay", "phi cơ giấy"),
        action_vi="đang lượn vòng trong lớp học",
        preferred_layer="sky",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("máy bay", "giấy", "gấp", "bay"),
    ),
    SpriteDefinition(
        sprite_key="teddy_bear",
        theme_key="happy_classroom",
        name_vi="gấu bông",
        category_vi="đồ chơi bạn nhỏ yêu thích",
        aliases_vi=("gấu", "gấu bông", "chú gấu", "con gấu"),
        action_vi="đang ngồi mỉm cười ở góc đọc sách",
        preferred_layer="ground",
        allowed_colors=("cam", "vàng", "tím", "đỏ"),
        focus_keywords=("gấu", "bông", "bạn", "đồ chơi"),
    ),
    # --- 3. mid_autumn_yard (7) ---
    SpriteDefinition(
        sprite_key="star_lantern",
        theme_key="mid_autumn_yard",
        name_vi="đèn ông sao",
        category_vi="đèn rước đêm Trung thu",
        aliases_vi=("đèn ông sao", "đèn lồng", "lồng đèn", "ngôi sao", "đèn ngôi sao", "đèn"),
        action_vi="đang tỏa sáng lung linh dưới trăng",
        preferred_layer="sky",
        allowed_colors=("đỏ", "vàng", "cam", "xanh dương", "tím"),
        focus_keywords=("đèn", "ông sao", "ngôi sao", "trung thu"),
    ),
    SpriteDefinition(
        sprite_key="rice_drum",
        theme_key="mid_autumn_yard",
        name_vi="trống cơm",
        category_vi="nhạc cụ lễ hội truyền thống",
        aliases_vi=("trống", "trống cơm", "cái trống", "chiếc trống", "trống lân"),
        action_vi="đang sẵn sàng vang nhịp tùng dinh",
        preferred_layer="ground",
        allowed_colors=("đỏ", "vàng", "cam", "xanh lá"),
        focus_keywords=("trống", "cơm", "nhạc", "hội"),
    ),
    SpriteDefinition(
        sprite_key="mooncake_plate",
        theme_key="mid_autumn_yard",
        name_vi="bánh trung thu",
        category_vi="món bánh ngọt ngày rằm",
        aliases_vi=("bánh trung thu", "bánh nướng", "bánh dẻo", "đĩa bánh", "bánh"),
        action_vi="đang bày thơm ngon trên mâm cỗ",
        preferred_layer="ground",
        allowed_colors=("cam", "vàng", "đỏ"),
        focus_keywords=("bánh", "trung thu", "nướng", "mâm cỗ"),
    ),
    SpriteDefinition(
        sprite_key="jade_rabbit",
        theme_key="mid_autumn_yard",
        name_vi="thỏ ngọc",
        category_vi="con vật đáng yêu đêm trăng",
        aliases_vi=("thỏ", "con thỏ", "chú thỏ", "thỏ ngọc", "thỏ trắng"),
        action_vi="đang vểnh tai ngắm trăng rằm",
        preferred_layer="mid",
        allowed_colors=("tím", "xanh dương", "vàng", "cam", "đỏ"),
        focus_keywords=("thỏ", "ngọc", "trăng", "rằm"),
    ),
    SpriteDefinition(
        sprite_key="lion_mask",
        theme_key="mid_autumn_yard",
        name_vi="đầu lân",
        category_vi="đồ chơi múa lân",
        aliases_vi=("đầu lân", "con lân", "múa lân", "mặt nạ lân", "lân"),
        action_vi="đang rực rỡ chuẩn bị múa hội",
        preferred_layer="mid",
        allowed_colors=("đỏ", "vàng", "xanh lá", "xanh dương"),
        supports_plural=False,
        focus_keywords=("lân", "đầu lân", "múa", "hội"),
    ),
    SpriteDefinition(
        sprite_key="carp_lantern",
        theme_key="mid_autumn_yard",
        name_vi="đèn cá chép",
        category_vi="lồng đèn hình con cá",
        aliases_vi=("đèn cá chép", "cá chép", "đèn cá", "lồng đèn cá", "con cá đèn"),
        action_vi="đang đung đưa lấp lánh trên cao",
        preferred_layer="sky",
        allowed_colors=("cam", "đỏ", "vàng", "tím", "xanh dương"),
        focus_keywords=("cá chép", "đèn", "lồng đèn"),
    ),
    SpriteDefinition(
        sprite_key="pomelo_fruit",
        theme_key="mid_autumn_yard",
        name_vi="quả bưởi",
        category_vi="trái cây trên mâm cỗ",
        aliases_vi=("bưởi", "quả bưởi", "trái bưởi"),
        action_vi="đang tròn xoe thơm ngát trên sân",
        preferred_layer="ground",
        allowed_colors=("xanh lá", "vàng"),
        focus_keywords=("bưởi", "quả", "trái cây"),
    ),
    # --- 4. seaside_morning (7) ---
    SpriteDefinition(
        sprite_key="sailboat",
        theme_key="seaside_morning",
        name_vi="thuyền buồm",
        category_vi="phương tiện trên mặt biển",
        aliases_vi=("thuyền", "thuyền buồm", "con thuyền", "chiếc thuyền", "tàu buồm"),
        action_vi="đang căng gió lướt trên sóng biển",
        preferred_layer="mid",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("thuyền", "buồm", "biển", "sóng"),
    ),
    SpriteDefinition(
        sprite_key="seashell",
        theme_key="seaside_morning",
        name_vi="vỏ sò",
        category_vi="vật nhỏ xinh trên bãi cát",
        aliases_vi=("vỏ sò", "sò", "vỏ ốc", "con ốc", "ốc biển"),
        action_vi="đang nằm lấp lánh trên cát mịn",
        preferred_layer="ground",
        allowed_colors=("cam", "tím", "vàng", "đỏ", "xanh dương"),
        focus_keywords=("vỏ sò", "sò", "ốc", "cát"),
    ),
    SpriteDefinition(
        sprite_key="starfish",
        theme_key="seaside_morning",
        name_vi="sao biển",
        category_vi="sinh vật biển hình ngôi sao",
        aliases_vi=("sao biển", "con sao biển", "ngôi sao biển"),
        action_vi="đang nghỉ ngơi bên mép nước",
        preferred_layer="ground",
        allowed_colors=("đỏ", "cam", "vàng", "tím"),
        focus_keywords=("sao biển", "sao", "biển"),
    ),
    SpriteDefinition(
        sprite_key="sandcastle",
        theme_key="seaside_morning",
        name_vi="lâu đài cát",
        category_vi="công trình bé xây bằng cát",
        aliases_vi=("lâu đài cát", "lâu đài", "thành cát", "nhà cát"),
        action_vi="đang dựng vững chắc với lá cờ nhỏ",
        preferred_layer="ground",
        allowed_colors=("vàng", "cam", "đỏ", "xanh dương"),
        supports_plural=False,
        focus_keywords=("lâu đài", "cát", "xây"),
    ),
    SpriteDefinition(
        sprite_key="seagull",
        theme_key="seaside_morning",
        name_vi="chim hải âu",
        category_vi="loài chim bay trên biển",
        aliases_vi=("hải âu", "chim hải âu", "con chim", "chim biển", "chim"),
        action_vi="đang sải cánh bay trên bầu trời biển",
        preferred_layer="sky",
        allowed_colors=("xanh dương", "cam", "vàng", "tím"),
        focus_keywords=("hải âu", "chim", "cánh", "biển"),
    ),
    SpriteDefinition(
        sprite_key="swim_ring",
        theme_key="seaside_morning",
        name_vi="phao bơi",
        category_vi="đồ dùng khi tắm biển",
        aliases_vi=("phao", "phao bơi", "chiếc phao", "cái phao", "phao tròn"),
        action_vi="đang bồng bềnh trên làn nước mát",
        preferred_layer="mid",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("phao", "bơi", "biển", "nước"),
    ),
    SpriteDefinition(
        sprite_key="beach_umbrella",
        theme_key="seaside_morning",
        name_vi="chiếc ô biển",
        category_vi="đồ che nắng trên bãi biển",
        aliases_vi=("ô", "cái ô", "chiếc ô", "ô biển", "cây dù", "cái dù", "dù che nắng"),
        action_vi="đang xòe rộng che bóng mát",
        preferred_layer="mid",
        allowed_colors=ALL_COLOR_KEYS,
        supports_plural=False,
        focus_keywords=("ô", "dù", "nắng", "biển"),
    ),
    # --- 5. countryside_pond (7) ---
    SpriteDefinition(
        sprite_key="lotus_flower",
        theme_key="countryside_pond",
        name_vi="hoa sen",
        category_vi="loài hoa thơm trên mặt ao",
        aliases_vi=("hoa sen", "bông sen", "sen", "đóa sen", "hoa"),
        action_vi="đang nở rộ trên lá xanh mát",
        preferred_layer="mid",
        allowed_colors=("đỏ", "tím", "vàng", "cam"),
        focus_keywords=("sen", "hoa sen", "ao", "lá"),
    ),
    SpriteDefinition(
        sprite_key="green_frog",
        theme_key="countryside_pond",
        name_vi="chú ếch",
        category_vi="con vật biết nhảy trên lá sen",
        aliases_vi=("ếch", "con ếch", "chú ếch", "ếch con", "ếch xanh"),
        action_vi="đang ngồi trên lá sen kêu ộp ộp",
        preferred_layer="ground",
        allowed_colors=("xanh lá", "vàng", "xanh dương"),
        focus_keywords=("ếch", "nhảy", "ao", "lá sen"),
    ),
    SpriteDefinition(
        sprite_key="dragonfly",
        theme_key="countryside_pond",
        name_vi="chuồn chuồn",
        category_vi="côn trùng có bốn cánh mỏng",
        aliases_vi=("chuồn chuồn", "con chuồn chuồn", "chuồn chuồn kim", "chuồn chuồn ớt"),
        action_vi="đang bay là là trên mặt nước",
        preferred_layer="sky",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("chuồn chuồn", "cánh", "bay"),
    ),
    SpriteDefinition(
        sprite_key="yellow_duck",
        theme_key="countryside_pond",
        name_vi="vịt con",
        category_vi="con vật biết bơi dưới ao",
        aliases_vi=("vịt", "con vịt", "vịt con", "chú vịt", "đàn vịt"),
        action_vi="đang bơi tung tăng trên mặt ao",
        preferred_layer="mid",
        allowed_colors=("vàng", "cam", "xanh dương"),
        focus_keywords=("vịt", "bơi", "ao", "nước"),
    ),
    SpriteDefinition(
        sprite_key="carp_fish",
        theme_key="countryside_pond",
        name_vi="cá chép",
        category_vi="con vật bơi lội dưới nước",
        aliases_vi=("cá", "con cá", "chú cá", "cá chép", "cá nhỏ"),
        action_vi="đang quẫy đuôi dưới làn nước trong",
        preferred_layer="ground",
        allowed_colors=("cam", "đỏ", "vàng", "xanh dương"),
        focus_keywords=("cá", "cá chép", "bơi", "ao"),
    ),
    SpriteDefinition(
        sprite_key="conical_hat",
        theme_key="countryside_pond",
        name_vi="nón lá",
        category_vi="đồ đội đầu truyền thống Việt Nam",
        aliases_vi=("nón", "nón lá", "chiếc nón", "cái nón"),
        action_vi="đang đặt gọn bên bờ ao quê",
        preferred_layer="ground",
        allowed_colors=("vàng", "cam", "xanh lá", "tím"),
        supports_plural=False,
        focus_keywords=("nón", "nón lá", "quê", "làng"),
    ),
    SpriteDefinition(
        sprite_key="bamboo_boat",
        theme_key="countryside_pond",
        name_vi="thuyền nan",
        category_vi="phương tiện chèo trên ao",
        aliases_vi=("thuyền nan", "thuyền", "con thuyền", "chiếc xuồng", "xuồng", "thuyền gỗ"),
        action_vi="đang neo nhẹ gần khóm sen",
        preferred_layer="mid",
        allowed_colors=("cam", "vàng", "xanh dương", "đỏ"),
        supports_plural=False,
        focus_keywords=("thuyền", "xuồng", "ao", "làng"),
    ),
    # --- 6. friendly_market (7) ---
    SpriteDefinition(
        sprite_key="watermelon",
        theme_key="friendly_market",
        name_vi="dưa hấu",
        category_vi="trái cây tròn ngọt mát",
        aliases_vi=("dưa hấu", "quả dưa hấu", "trái dưa hấu", "quả dưa", "dưa"),
        action_vi="đang bày tươi ngon trên sạp chợ",
        preferred_layer="ground",
        allowed_colors=("xanh lá", "đỏ"),
        focus_keywords=("dưa", "dưa hấu", "quả", "ngọt"),
    ),
    SpriteDefinition(
        sprite_key="banana_bunch",
        theme_key="friendly_market",
        name_vi="nải chuối",
        category_vi="trái cây thơm chín",
        aliases_vi=("chuối", "nải chuối", "quả chuối", "trái chuối"),
        action_vi="đang chín vàng ươm trên sạp hàng",
        preferred_layer="mid",
        allowed_colors=("vàng", "xanh lá"),
        focus_keywords=("chuối", "nải chuối", "chín", "quả"),
    ),
    SpriteDefinition(
        sprite_key="woven_basket",
        theme_key="friendly_market",
        name_vi="giỏ mây",
        category_vi="đồ đựng đi chợ thân quen",
        aliases_vi=("giỏ", "giỏ mây", "cái giỏ", "chiếc giỏ", "rổ mây"),
        action_vi="đang đặt gọn chờ đựng quà quê",
        preferred_layer="ground",
        allowed_colors=("cam", "vàng", "xanh lá", "tím"),
        supports_plural=False,
        focus_keywords=("giỏ", "mây", "chợ", "đựng"),
    ),
    SpriteDefinition(
        sprite_key="clay_piggy",
        theme_key="friendly_market",
        name_vi="heo đất",
        category_vi="đồ chơi tiết kiệm đáng yêu",
        aliases_vi=("heo đất", "lợn đất", "con heo", "con lợn", "ống heo"),
        action_vi="đang cười tươi ở quầy đồ chơi",
        preferred_layer="mid",
        allowed_colors=("đỏ", "cam", "vàng", "tím", "xanh dương"),
        focus_keywords=("heo", "lợn", "đất", "tiết kiệm"),
    ),
    SpriteDefinition(
        sprite_key="pinwheel",
        theme_key="friendly_market",
        name_vi="chong chóng",
        category_vi="đồ chơi quay tít theo gió",
        aliases_vi=("chong chóng", "cái chong chóng", "chong chóng gió", "chong chóng giấy"),
        action_vi="đang xoay tít khi gió thổi qua",
        preferred_layer="sky",
        allowed_colors=ALL_COLOR_KEYS,
        focus_keywords=("chong chóng", "gió", "quay"),
    ),
    SpriteDefinition(
        sprite_key="banh_chung",
        theme_key="friendly_market",
        name_vi="bánh chưng",
        category_vi="món bánh vuông truyền thống",
        aliases_vi=("bánh chưng", "chiếc bánh chưng", "bánh vuông", "bánh"),
        action_vi="đang buộc lạt gọn gàng thơm phức",
        preferred_layer="ground",
        allowed_colors=("xanh lá", "vàng"),
        focus_keywords=("bánh chưng", "bánh", "vuông", "lạt"),
    ),
    SpriteDefinition(
        sprite_key="mango_fruit",
        theme_key="friendly_market",
        name_vi="quả xoài",
        category_vi="trái cây chín thơm lừng",
        aliases_vi=("xoài", "quả xoài", "trái xoài", "xoài chín"),
        action_vi="đang bày đẹp mắt trong sạp trái cây",
        preferred_layer="mid",
        allowed_colors=("vàng", "cam", "xanh lá"),
        focus_keywords=("xoài", "quả", "chín", "trái cây"),
    ),
)

SPRITE_BY_KEY: dict[str, SpriteDefinition] = {s.sprite_key: s for s in SPRITE_CATALOG}
SPRITES_BY_THEME: dict[ThemeKey, tuple[SpriteDefinition, ...]] = {
    theme_key: tuple(s for s in SPRITE_CATALOG if s.theme_key == theme_key)
    for theme_key in THEME_KEYS
}

# Cross-theme gentle guest sprites used only when Grade 4-5 needs 8 or 9 unique objects
CROSS_THEME_GUEST_KEYS: tuple[str, ...] = (
    "singing_bird",
    "butterfly",
    "paper_kite",
    "garden_ball",
    "pinwheel",
    "open_book",
    "dragonfly",
    "paper_plane",
    "star_lantern",
)

TIMER_OPTIONS: tuple[TimerOptionRead, ...] = (
    TimerOptionRead(mode="10S", seconds=10, label_vi="10 giây", recommended_for_vi="Thử thách siêu nhanh"),
    TimerOptionRead(mode="20S", seconds=20, label_vi="20 giây", recommended_for_vi="Nhanh nhẹn (Lớp 4–5)"),
    TimerOptionRead(mode="30S", seconds=30, label_vi="30 giây", recommended_for_vi="Cân bằng (Lớp 2–3)"),
    TimerOptionRead(mode="60S", seconds=60, label_vi="60 giây", recommended_for_vi="Thoải mái (Lớp 1–2)"),
    TimerOptionRead(mode="90S", seconds=90, label_vi="90 giây", recommended_for_vi="Quan sát thật kỹ"),
    TimerOptionRead(mode="120S", seconds=120, label_vi="120 giây", recommended_for_vi="Chậm rãi từng chi tiết"),
    TimerOptionRead(mode="UNLIMITED", seconds=None, label_vi="Không giới hạn", recommended_for_vi="Tự bấm khi bé nhớ xong"),
)

TIMER_SECONDS_BY_MODE: dict[TimerMode, int | None] = {
    opt.mode: opt.seconds for opt in TIMER_OPTIONS
}

GRADE_RECOMMENDATIONS: tuple[GradeRecommendationRead, ...] = (
    GradeRecommendationRead(
        grade=1,
        min_objects=3,
        max_objects=4,
        recommended_timer="60S",
        recommended_recall_mode="GUIDED_RECALL",
        recommended_difficulty=1,
        note_vi="Lớp 1: 3–4 chi tiết rõ ràng, màu sắc tươi sáng để bé dễ ghi nhớ.",
    ),
    GradeRecommendationRead(
        grade=2,
        min_objects=5,
        max_objects=6,
        recommended_timer="30S",
        recommended_recall_mode="GUIDED_RECALL",
        recommended_difficulty=2,
        note_vi="Lớp 2: 5–6 chi tiết sinh động, rèn nhớ tên và màu sắc.",
    ),
    GradeRecommendationRead(
        grade=3,
        min_objects=5,
        max_objects=6,
        recommended_timer="30S",
        recommended_recall_mode="FREE_RECALL",
        recommended_difficulty=3,
        note_vi="Lớp 3: 5–6 chi tiết, kết hợp kể tự do và nhớ vị trí.",
    ),
    GradeRecommendationRead(
        grade=4,
        min_objects=7,
        max_objects=9,
        recommended_timer="20S",
        recommended_recall_mode="FREE_RECALL",
        recommended_difficulty=4,
        note_vi="Lớp 4: 7–9 chi tiết phong phú, rèn nhớ số lượng và kể tiếp câu chuyện.",
    ),
    GradeRecommendationRead(
        grade=5,
        min_objects=7,
        max_objects=9,
        recommended_timer="20S",
        recommended_recall_mode="FREE_RECALL",
        recommended_difficulty=5,
        note_vi="Lớp 5: 7–9 chi tiết thử thách, phát triển trí nhớ làm việc và óc sáng tạo.",
    ),
)


def fold_vietnamese(text: str) -> str:
    lowered = re.sub(r"[^\w\s]", " ", text.casefold(), flags=re.UNICODE)
    lowered = lowered.replace("đ", "d")
    decomposed = unicodedata.normalize("NFD", lowered)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return " ".join(stripped.split())


def timer_seconds_for_mode(timer_mode: TimerMode) -> int | None:
    return TIMER_SECONDS_BY_MODE[timer_mode]


def grade_object_count_bounds(child_grade: int) -> tuple[int, int]:
    grade = max(1, min(5, int(child_grade)))
    if grade == 1:
        return 3, 4
    if grade in (2, 3):
        return 5, 6
    return 7, 9


def compute_object_count(child_grade: int, difficulty_level: int) -> int:
    grade = max(1, min(5, int(child_grade)))
    difficulty = max(1, min(5, int(difficulty_level)))
    if grade == 1:
        return 3 if difficulty <= 2 else 4
    if grade in (2, 3):
        return 5 if difficulty <= 2 else 6
    if difficulty <= 2:
        return 7
    if difficulty == 3:
        return 8
    return 9


def default_difficulty_for_grade(child_grade: int) -> int:
    grade = max(1, min(5, int(child_grade)))
    return grade


def get_themes_catalog() -> MemoryThemesCatalogRead:
    theme_reads = [
        MemoryThemeRead(
            theme_key=theme.theme_key,
            name_vi=theme.name_vi,
            description_vi=theme.description_vi,
            badge_vi=theme.badge_vi,
            accent_hex=theme.backdrop.accent_hex,
            sprite_count=len(SPRITES_BY_THEME[theme.theme_key]),
            sample_items_vi=[s.name_vi for s in SPRITES_BY_THEME[theme.theme_key][:4]],
        )
        for theme in THEMES
    ]
    return MemoryThemesCatalogRead(
        themes=theme_reads,
        timer_options=list(TIMER_OPTIONS),
        grade_recommendations=list(GRADE_RECOMMENDATIONS),
        total_sprites=len(SPRITE_CATALOG),
    )


def resolve_theme_key(selection: str, seed: int) -> ThemeKey:
    if selection in THEME_BY_KEY:
        return selection  # type: ignore[return-value]
    digest = hashlib.sha256(f"theme:{seed}".encode("utf-8")).digest()
    idx = int.from_bytes(digest[:4], "big") % len(THEME_KEYS)
    return THEME_KEYS[idx]


def _normalize_focus_words(focus_words: list[str] | None) -> tuple[str, ...]:
    if not focus_words:
        return ()
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in focus_words:
        if not isinstance(raw, str):
            continue
        compact = unicodedata.normalize("NFC", " ".join(raw.strip().split()))
        if not compact:
            continue
        folded = compact.casefold()
        if not folded or folded in seen:
            continue
        seen.add(folded)
        cleaned.append(compact[:48])
        if len(cleaned) >= 12:
            break
    return tuple(cleaned)


def _sprite_matches_focus_word(sprite: SpriteDefinition, focus_word: str) -> bool:
    # Preserve Vietnamese tones: e.g. "diều" and "điều" are different words.
    def normalized_tokens(value: str) -> str:
        value = unicodedata.normalize("NFC", value).casefold()
        return " ".join(re.sub(r"[^\w\s]", " ", value, flags=re.UNICODE).split())

    focus = normalized_tokens(focus_word)
    if not focus or len(focus) < 2:
        return False
    haystacks = [sprite.name_vi, *sprite.aliases_vi, *sprite.focus_keywords]
    for candidate in haystacks:
        candidate_text = normalized_tokens(candidate)
        if not candidate_text:
            continue
        if f" {focus} " in f" {candidate_text} ":
            return True
    return False


def _initial_clue_vi(name_vi: str) -> str:
    parts = [p for p in name_vi.strip().split() if p]
    if not parts:
        return "…"
    first = parts[0]
    if len(parts) >= 2:
        return f"“{first} {parts[1][0]}…”"
    return f"“{first[:2]}…”"


def _build_hint_tiers(
    sprite: SpriteDefinition,
    color_vi: CanonicalColorVi,
    position_zone: PositionZone,
    count: int,
) -> ObjectHintTiers:
    count_phrase = "1 chi tiết" if count == 1 else f"{count} chi tiết giống nhau"
    tier_1 = f"Trong tranh có một {sprite.category_vi} rất quen thuộc đó bé!"
    tier_2 = (
        f"Bé hãy nhớ lại góc {position_zone}: ở đó có một {sprite.category_vi} "
        f"màu {color_vi} ({count_phrase})."
    )
    tier_3 = (
        f"Bật mí nhỏ nè: chi tiết màu {color_vi} ở góc {position_zone} "
        f"bắt đầu bằng {_initial_clue_vi(sprite.name_vi)}."
    )
    return ObjectHintTiers(tier_1=tier_1, tier_2=tier_2, tier_3=tier_3)


def _assign_slots(
    sprites: list[SpriteDefinition],
    rng: random.Random,
) -> list[tuple[SpriteDefinition, LayoutSlot]]:
    free_slots: list[LayoutSlot] = list(LAYOUT_SLOTS)
    assignments: list[tuple[SpriteDefinition, LayoutSlot]] = []

    # Place preferred layer sprites first so sky items go high and ground items sit low.
    layer_priority: dict[LayerKind, int] = {"sky": 0, "ground": 1, "mid": 2}
    ordered_sprites = sorted(
        sprites,
        key=lambda sp: (layer_priority[sp.preferred_layer], sp.sprite_key),
    )

    for sprite in ordered_sprites:
        matching_layer = [slot for slot in free_slots if slot.layer == sprite.preferred_layer]
        pool = matching_layer if matching_layer else free_slots
        chosen = pool[rng.randrange(len(pool))]
        free_slots.remove(chosen)
        assignments.append((sprite, chosen))

    # Deterministic visual reading order (top-to-bottom, left-to-right)
    assignments.sort(key=lambda pair: pair[1].slot_id)
    return assignments


def _choose_count(
    sprite: SpriteDefinition,
    *,
    child_grade: int,
    difficulty_level: int,
    plural_used: int,
    rng: random.Random,
) -> int:
    if not sprite.supports_plural:
        return 1
    if child_grade == 1:
        if plural_used >= 1:
            return 1
        return 2 if rng.random() < 0.35 else 1
    if child_grade in (2, 3):
        if plural_used >= 2:
            return 1
        roll = rng.random()
        if difficulty_level >= 4 and roll < 0.22:
            return 3
        if roll < 0.50:
            return 2
        return 1
    # Grades 4-5
    if plural_used >= 3:
        return 1
    roll = rng.random()
    if roll < 0.25:
        return 3
    if roll < 0.55:
        return 2
    return 1


def generate_scene_spec(
    *,
    theme_key: ThemeKey,
    child_grade: int,
    difficulty_level: int,
    scene_seed: int,
    focus_words: list[str] | None = None,
) -> SceneSpec:
    """Deterministically compose a collision-free Vietnamese SVG scene with exact ground truth."""
    if theme_key not in THEME_BY_KEY:
        raise ValueError(f"Unsupported theme_key: {theme_key}")

    grade = max(1, min(5, int(child_grade)))
    difficulty = max(1, min(5, int(difficulty_level)))
    seed = max(0, int(scene_seed))
    normalized_focus = _normalize_focus_words(focus_words)

    seed_material = f"v4|{theme_key}|{grade}|{difficulty}|{seed}|{'|'.join(normalized_focus)}"
    seed_bytes = hashlib.sha256(seed_material.encode("utf-8")).digest()
    rng = random.Random(int.from_bytes(seed_bytes[:8], "big"))

    theme = THEME_BY_KEY[theme_key]
    target_count = compute_object_count(grade, difficulty)

    theme_pool = list(SPRITES_BY_THEME[theme_key])
    guest_pool = [
        SPRITE_BY_KEY[key]
        for key in CROSS_THEME_GUEST_KEYS
        if SPRITE_BY_KEY[key].theme_key != theme_key
    ]
    all_candidates = theme_pool + [s for s in SPRITE_CATALOG if s.theme_key != theme_key]

    # 1. Prioritize sprites that match the child's difficult reading words (`focus_words`)
    selected: list[SpriteDefinition] = []
    selected_keys: set[str] = set()
    matched_focus_words: list[str] = []
    focus_sprite_keys: set[str] = set()

    if normalized_focus:
        # Prefer theme sprites first, then any matching sprite in catalog
        for focus_word in normalized_focus:
            matched_sprite = next(
                (
                    sp
                    for sp in theme_pool
                    if sp.sprite_key not in selected_keys and _sprite_matches_focus_word(sp, focus_word)
                ),
                None,
            )
            if matched_sprite is None:
                matched_sprite = next(
                    (
                        sp
                        for sp in all_candidates
                        if sp.sprite_key not in selected_keys and _sprite_matches_focus_word(sp, focus_word)
                    ),
                    None,
                )
            if matched_sprite is not None and len(selected) < target_count:
                selected.append(matched_sprite)
                selected_keys.add(matched_sprite.sprite_key)
                focus_sprite_keys.add(matched_sprite.sprite_key)
                matched_focus_words.append(focus_word)

    # 2. Fill remaining slots from the chosen theme's pool deterministically
    remaining_theme = [sp for sp in theme_pool if sp.sprite_key not in selected_keys]
    rng.shuffle(remaining_theme)
    for sp in remaining_theme:
        if len(selected) >= target_count:
            break
        selected.append(sp)
        selected_keys.add(sp.sprite_key)

    # 3. For Grade 4-5 scenes with 8-9 objects, fill remaining 1-2 objects with cross-theme guests
    if len(selected) < target_count:
        remaining_guests = [sp for sp in guest_pool if sp.sprite_key not in selected_keys]
        rng.shuffle(remaining_guests)
        for sp in remaining_guests:
            if len(selected) >= target_count:
                break
            selected.append(sp)
            selected_keys.add(sp.sprite_key)

    # Assign collision-free layout slots
    slot_pairs = _assign_slots(selected, rng)

    # Maximize color contrast by spreading canonical colors across objects
    used_color_counts: dict[CanonicalColorVi, int] = {c: 0 for c in ALL_COLOR_KEYS}
    plural_used = 0
    objects: list[SceneObjectSpec] = []

    for index, (sprite, slot) in enumerate(slot_pairs, start=1):
        allowed = list(sprite.allowed_colors)
        min_use = min(used_color_counts[c] for c in allowed)
        least_used_colors = [c for c in allowed if used_color_counts[c] == min_use]
        chosen_color_vi = least_used_colors[rng.randrange(len(least_used_colors))]
        used_color_counts[chosen_color_vi] += 1
        palette = COLOR_BY_VI[chosen_color_vi]

        count = _choose_count(
            sprite,
            child_grade=grade,
            difficulty_level=difficulty,
            plural_used=plural_used,
            rng=rng,
        )
        if count > 1:
            plural_used += 1

        # Tiny bounded jitter (<= 0.01) keeps scene lively while strictly preserving non-overlap
        jitter_x = round((rng.random() - 0.5) * 0.018, 4)
        jitter_y = round((rng.random() - 0.5) * 0.016, 4)
        bx = round(max(0.03, min(0.96 - slot.w, slot.x + jitter_x)), 4)
        by = round(max(0.05, min(0.94 - slot.h, slot.y + jitter_y)), 4)
        bbox = SceneBBox(x=bx, y=by, w=slot.w, h=slot.h)

        hint_tiers = _build_hint_tiers(sprite, chosen_color_vi, slot.position_zone, count)

        objects.append(
            SceneObjectSpec(
                id=f"obj_{index}_{sprite.sprite_key}",
                sprite_key=sprite.sprite_key,
                name_vi=sprite.name_vi,
                category_vi=sprite.category_vi,
                aliases_vi=list(sprite.aliases_vi),
                color_vi=palette.color_vi,
                color_hex=palette.hex_code,
                color_stroke_hex=palette.stroke_hex,
                color_light_hex=palette.light_hex,
                shape_cue=palette.shape_cue,
                count=count,
                position_zone=slot.position_zone,
                bbox=bbox,
                action_vi=sprite.action_vi,
                hint_tiers=hint_tiers,
                is_focus_word=sprite.sprite_key in focus_sprite_keys,
            )
        )

    observation_tips = [
        "Nhìn từ trên xuống dưới, từ trái sang phải để không bỏ sót chi tiết nào nhé!",
        "Đếm nhẩm xem mỗi đồ vật hoặc con vật có mấy cái và mang màu gì.",
        "Tưởng tượng một câu chuyện ngắn nối các nhân vật lại với nhau sẽ nhớ rất lâu!",
    ]

    guided_questions = _build_guided_questions(objects)
    matched_lower = {w.casefold() for w in matched_focus_words}
    creative_focus_words = [
        w for w in normalized_focus if w.casefold() not in matched_lower
    ][:3]

    return SceneSpec(
        schema_version="v4.0",
        theme_key=theme.theme_key,
        theme_name_vi=theme.name_vi,
        child_grade=grade,
        difficulty_level=difficulty,
        scene_seed=seed,
        canvas_width=800,
        canvas_height=500,
        backdrop=theme.backdrop,
        objects=objects,
        observation_tips_vi=observation_tips,
        guided_questions_vi=guided_questions,
        creative_prompt_vi=theme.creative_prompt_vi,
        matched_focus_words=matched_focus_words,
        creative_focus_words=creative_focus_words,
    )


def _build_guided_questions(objects: list[SceneObjectSpec]) -> list[str]:
    if not objects:
        return ["Bé nhớ trong bức tranh vừa rồi có những gì nào?"]

    questions: list[str] = [
        "Bé nhớ trong bức tranh vừa rồi có những con vật hoặc đồ vật nào?",
    ]
    plural_obj = next((o for o in objects if o.count > 1), None)
    if plural_obj is not None:
        questions.append(
            f"Trong bức tranh có một {plural_obj.category_vi} xuất hiện nhiều hơn 1 cái — bé nhớ là gì và có mấy cái không?"
        )
    else:
        first = objects[0]
        questions.append(
            f"Ở phía {first.position_zone}, bé nhớ có chi tiết nào và màu gì không?"
        )

    if len(objects) >= 2:
        last = objects[-1]
        questions.append(
            f"Còn ở góc {last.position_zone}, có chi tiết màu {last.color_vi} nào bé ấn tượng nhất?"
        )
    return questions[:3]


def bboxes_overlap(a: SceneBBox, b: SceneBBox, margin: float = 0.0) -> bool:
    """Return True if two normalized bounding boxes overlap (with optional safety margin)."""
    return not (
        a.x + a.w + margin <= b.x
        or b.x + b.w + margin <= a.x
        or a.y + a.h + margin <= b.y
        or b.y + b.h + margin <= a.y
    )
