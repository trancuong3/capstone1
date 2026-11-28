"""Curated Copyright-Clean Vietnamese Children's Book Catalog (Grades 1–5, 3 Pages Each).

Provides 5 original Vietnamese educational storybooks (CC0 1.0 Public Domain Dedication),
strictly 1 book per grade from Grade 1 to Grade 5, each containing 3 pages:
1. Lớp 1: Chú Mèo Mun Đi Học (3 trang — câu ngắn 6–9 tiếng, âm vần cơ bản m/n, tr/ch, l/n)
2. Lớp 2: Khu Vườn Nhỏ Của Bé Na (3 trang — đoạn văn sinh động, âm r/d/gi, s/x, từ láy nhẹ)
3. Lớp 3: Chiếc Đèn Lồng Ánh Sao (3 trang — giàu hình ảnh so sánh, phân biệt thanh hỏi/ngã)
4. Lớp 4: Hành Trình Của Giọt Sương Mai (3 trang — văn miêu tả thiên nhiên & khoa học thường thức)
5. Lớp 5: Người Gác Hải Đăng Đảo Xa (3 trang — chủ đề biển đảo quê hương, lòng kiên cường)

Deterministically renders:
- Crisp typeset 960x1280 JPEG reading page scans with exact pixel-measured word bounding boxes
  and verified `word_box_geometry` fingerprints (`has_verified_geometry == True`).
- 3:4 WebP book covers (`<= 300 KB`) validated via `validate_and_process_cover_image`.
- Smooth pastel text-free WebP page illustrations (`<= 350 KB`) verified via `verify_illustration_text_free`.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import unicodedata
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from app.services.book_cover_service import (
    _encode_optimized_webp,
    validate_and_process_cover_image,
)
from app.services.book_illustration_service import (
    MAX_ILLUSTRATION_WEBP_BYTES,
    _build_default_ocr_check_fn,
    verify_illustration_text_free,
)
from app.services.ocr_ai.child_safety import (
    content_hash as safety_content_hash,
    normalize_safety_text,
)
from app.services.ocr_text_utils import normalize_text_tokens, normalize_word
from app.services.word_box_geometry import build_geometry_evidence, has_verified_geometry

PAGE_IMAGE_WIDTH = 960
PAGE_IMAGE_HEIGHT = 1280
ILLUST_WIDTH = 960
ILLUST_HEIGHT = 720


@dataclass(frozen=True, slots=True)
class ChildrenBookPageSpec:
    page_number: int
    scene_motif: str
    paragraphs: tuple[str, ...]

    @property
    def canonical_text(self) -> str:
        return unicodedata.normalize(
            "NFC", "\n\n".join(p.strip() for p in self.paragraphs if p.strip())
        )


@dataclass(frozen=True, slots=True)
class ChildrenBookSpec:
    slug: str
    name: str
    title: str
    author: str
    grade: int
    pedagogy_focus: str
    source_declaration: str
    palette: tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]]
    cover_motif: str
    pages: tuple[ChildrenBookPageSpec, ...]

    @property
    def min_grade(self) -> int:
        return self.grade

    @property
    def max_grade(self) -> int:
        return self.grade

    @property
    def deterministic_book_id(self) -> UUID:
        return uuid5(NAMESPACE_URL, f"viread:books:children-pack:book:{self.slug}")

    def deterministic_page_id(self, page_number: int) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:page:{page_number}",
        )

    def deterministic_revision_id(self, page_number: int) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:page:{page_number}:rev:1",
        )

    def deterministic_workflow_id(self, page_number: int) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:page:{page_number}:workflow:1",
        )

    @property
    def deterministic_cover_asset_id(self) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:cover:v1",
        )

    def deterministic_illustration_asset_id(self, page_number: int) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:page:{page_number}:illust:v1",
        )

    @property
    def deterministic_rights_id(self) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:rights:v1",
        )

    def deterministic_word_id(self, page_number: int, word_index: int) -> UUID:
        return uuid5(
            NAMESPACE_URL,
            f"viread:books:children-pack:book:{self.slug}:page:{page_number}:word:{word_index}",
        )


CHILDREN_BOOKS_PACK: tuple[ChildrenBookSpec, ...] = (
    ChildrenBookSpec(
        slug="lop-1-chu-meo-mun-di-hoc",
        name="Chú Mèo Mun Đi Học (Lớp 1)",
        title="Chú Mèo Mun Đi Học",
        author="ViRead Sư phạm Tiếng Việt (CC0)",
        grade=1,
        pedagogy_focus="Câu ngắn 6–9 tiếng, vần cơ bản, phụ âm m/n, l/n, tr/ch chuẩn SGK Lớp 1",
        source_declaration="Tác phẩm giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        palette=((255, 247, 237), (251, 146, 60), (154, 52, 18)),
        cover_motif="school_sun",
        pages=(
            ChildrenBookPageSpec(
                page_number=1,
                scene_motif="morning_sun",
                paragraphs=(
                    "Sáng sớm, nắng vàng chiếu qua khung cửa sổ nhỏ.",
                    "Mèo Mun thức dậy thật nhanh, rửa mặt sạch sẽ rồi đeo chiếc cặp mới.",
                    "Mẹ xoa đầu Mun và dặn con đến lớp nhớ vâng lời cô giáo.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=2,
                scene_motif="school_tree",
                paragraphs=(
                    "Ở lớp Một, cô giáo Hươu Sao mỉm cười đón các bạn nhỏ.",
                    "Cô viết lên bảng xanh những chữ cái tròn trịa và rõ ràng.",
                    "Mèo Mun cùng bạn Thỏ Trắng chăm chú đánh vần từng tiếng vang khắp phòng.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=3,
                scene_motif="rainbow_meadow",
                paragraphs=(
                    "Giờ ra chơi, sân trường rộn ràng tiếng cười dưới bóng cây bàng xanh.",
                    "Chiều về, Mèo Mun khoe với mẹ bài tập đọc đầu tiên đạt điểm tốt.",
                    "Mun thấy mỗi ngày đi học đều thật vui và ấm áp.",
                ),
            ),
        ),
    ),
    ChildrenBookSpec(
        slug="lop-2-khu-vuon-nho-cua-be-na",
        name="Khu Vườn Nhỏ Của Bé Na (Lớp 2)",
        title="Khu Vườn Nhỏ Của Bé Na",
        author="ViRead Sư phạm Tiếng Việt (CC0)",
        grade=2,
        pedagogy_focus="Đoạn văn kể việc gắn thiên nhiên, luyện âm r/d/gi, s/x và từ chỉ đặc điểm Lớp 2",
        source_declaration="Tác phẩm giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        palette=((236, 253, 245), (52, 211, 153), (6, 95, 70)),
        cover_motif="sunflower_garden",
        pages=(
            ChildrenBookPageSpec(
                page_number=1,
                scene_motif="garden_sprout",
                paragraphs=(
                    "Cuối tuần, bé Na theo ông nội ra mảnh vườn nhỏ nằm bên hiên nhà.",
                    "Ông xới đất tơi xốp rồi trao cho Na những hạt giống hoa hướng dương căng tròn.",
                    "Na khẽ đặt từng hạt xuống hố nhỏ, lấp đất mềm và tưới làn nước mát lành.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=2,
                scene_motif="gentle_rain",
                paragraphs=(
                    "Ít hôm sau, cơn mưa rào đầu hạ ghé qua làm khu vườn bừng tỉnh.",
                    "Những mầm non xanh biếc đội đất nhô lên, xòe hai chiếc lá nhỏ xinh đón nắng sớm.",
                    "Mỗi buổi chiều đi học về, Na đều ra vườn nhổ cỏ và trò chuyện cùng cây.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=3,
                scene_motif="sunflower_bloom",
                paragraphs=(
                    "Tháng sáu về, cây hướng dương vươn cao rồi nở bông hoa vàng rực như mặt trời nhỏ.",
                    "Mấy chú chim sâu ríu rít chuyền cành, giúp khu vườn bắt sâu và ca hát suốt ngày.",
                    "Ông nội mỉm cười bảo rằng bàn tay chăm chỉ của Na đã ươm nên mùa hoa đẹp.",
                ),
            ),
        ),
    ),
    ChildrenBookSpec(
        slug="lop-3-chiec-den-long-anh-sao",
        name="Chiếc Đèn Lồng Ánh Sao (Lớp 3)",
        title="Chiếc Đèn Lồng Ánh Sao",
        author="ViRead Sư phạm Tiếng Việt (CC0)",
        grade=3,
        pedagogy_focus="Câu văn giàu hình ảnh so sánh, phân biệt thanh hỏi/ngã và lòng sẻ chia Lớp 3",
        source_declaration="Tác phẩm giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        palette=((254, 249, 195), (245, 158, 11), (146, 64, 14)),
        cover_motif="star_lantern",
        pages=(
            ChildrenBookPageSpec(
                page_number=1,
                scene_motif="autumn_moon",
                paragraphs=(
                    "Mùa thu sang, gió heo may thổi nhẹ mang theo hương cốm mới thơm dịu khắp con ngõ nhỏ.",
                    "Hai anh em Minh và An ngồi bên hiên nhà, tỉ mỉ vót từng thanh tre mảnh dẻ để làm đèn ông sao.",
                    "Những tấm giấy bóng kính đỏ thắm và vàng tươi được dán căng phẳng, lấp lánh dưới nắng chiều.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=2,
                scene_motif="lantern_glow",
                paragraphs=(
                    "Đêm rằm tháng Tám, vầng trăng tròn vằng vặc tỏa ánh sáng dịu hiền xuống sân đình nhộn nhịp.",
                    "Giữa tiếng trống lân rộn rã, An chợt thấy bé Bi nhà bên đang đứng nép bên mẹ, đôi mắt chăm chú nhìn đoàn rước đèn.",
                    "Chiếc đèn giấy của Bi chẳng may bị gió làm rách quai nên em chưa thể nhập hội cùng các bạn.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=3,
                scene_motif="starry_night_bridge",
                paragraphs=(
                    "Hai anh em nhìn nhau mỉm cười rồi ân cần trao tặng bé Bi một chiếc đèn ông sao năm cánh vững chãi.",
                    "Đôi mắt Bi sáng bừng niềm vui, bàn tay nhỏ xíu nâng niu ánh đèn lung linh như giữ một vì sao ấm áp.",
                    "Đêm hội Trung thu năm ấy trở nên rực rỡ hơn bởi niềm vui được sẻ chia giữa những người bạn hiền.",
                ),
            ),
        ),
    ),
    ChildrenBookSpec(
        slug="lop-4-hanh-trinh-cua-giot-suong-mai",
        name="Hành Trình Của Giọt Sương Mai (Lớp 4)",
        title="Hành Trình Của Giọt Sương Mai",
        author="ViRead Sư phạm Tiếng Việt (CC0)",
        grade=4,
        pedagogy_focus="Văn miêu tả nhân hóa sinh động kết hợp kiến thức vòng tuần hoàn tự nhiên Lớp 4",
        source_declaration="Tác phẩm giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        palette=((224, 242, 254), (56, 189, 248), (7, 89, 133)),
        cover_motif="lotus_dew",
        pages=(
            ChildrenBookPageSpec(
                page_number=1,
                scene_motif="lotus_pond",
                paragraphs=(
                    "Khi bình minh vừa hé rạng phía chân trời, Giọt Sương Mai thức giấc trên phiến lá sen xanh mướt giữa đầm làng.",
                    "Trong ánh nắng đầu ngày trong trẻo, Sương Mai tròn xoe như viên ngọc pha lê, phản chiếu sắc hồng dịu dàng của những cánh sen thơm ngát.",
                    "Làn gió sớm lướt qua khẽ đung đưa tàu lá, hát khúc nhạc êm đềm tiễn Sương Mai bước vào chuyến du hành kỳ diệu.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=2,
                scene_motif="clouds_sky",
                paragraphs=(
                    "Mặt trời càng lên cao, những tia nắng ấm áp nâng Giọt Sương Mai hóa thành làn hơi mỏng manh bay vút lên bầu trời xanh thẳm.",
                    "Trên tầng không lộng gió, Sương Mai gặp gỡ hàng triệu người bạn nhỏ để cùng kết thành đám mây trắng bồng bềnh như tấm thảm bông.",
                    "Đám mây thong thả trôi qua những dãy núi trùng điệp, ngắm nhìn dòng sông uốn lượn và những mái trường ngói đỏ thân thương.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=3,
                scene_motif="golden_field_rain",
                paragraphs=(
                    "Chiều xuống, khi đám mây đã gom đầy hơi nước mát lạnh, gió mùa đưa cả đoàn mây trở về trên cánh đồng quê hương đang khát nắng.",
                    "Sương Mai cùng các bạn hóa thành cơn mưa rào trong lành, tưới tắm cho ruộng lúa trổ đòng và những hàng cây ven đê xanh tươi sức sống.",
                    "Thấm vào lòng đất mẹ rồi hòa cùng dòng suối nhỏ, Sương Mai hiểu rằng mỗi hành trình cho đi đều làm cuộc đời thêm tươi đẹp.",
                ),
            ),
        ),
    ),
    ChildrenBookSpec(
        slug="lop-5-nguoi-gac-hai-dang-dao-xa",
        name="Người Gác Hải Đăng Đảo Xa (Lớp 5)",
        title="Người Gác Hải Đăng Đảo Xa",
        author="ViRead Sư phạm Tiếng Việt (CC0)",
        grade=5,
        pedagogy_focus="Câu ghép giàu nhịp điệu, từ vựng biển đảo quê hương và ý thức trách nhiệm Lớp 5",
        source_declaration="Tác phẩm giáo dục gốc của dự án ViRead phát hành theo CC0 1.0 Public Domain Dedication.",
        palette=((224, 231, 255), (99, 102, 241), (30, 58, 138)),
        cover_motif="lighthouse_sea",
        pages=(
            ChildrenBookPageSpec(
                page_number=1,
                scene_motif="lighthouse_sunset",
                paragraphs=(
                    "Giữa vùng biển xanh mênh mông nơi đảo tiền tiêu, ngọn hải đăng trắng muốt vươn mình sừng sững trên mỏm đá hướng ra đại dương bao la.",
                    "Suốt hơn hai mươi năm qua, bác Hải vẫn đều đặn leo lên những bậc thang xoắn ốc mỗi buổi hoàng hôn để lau chùi thấu kính và kiểm tra nguồn sáng.",
                    "Với bác, ánh đèn nơi đầu sóng không chỉ là tín hiệu hàng hải mà còn là lời chào ấm áp gửi tới những con tàu đang ngày đêm bám biển.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=2,
                scene_motif="lighthouse_beam",
                paragraphs=(
                    "Có những đêm mưa lớn giăng kín mặt khơi, từng đợt sóng bạc đầu vỗ ầm ào vào chân đảo nhưng ngọn hải đăng vẫn kiên cường tỏa sáng.",
                    "Luồng sáng vàng rực quay đều xuyên qua màn sương dày đặc, trở thành điểm tựa tin cậy dẫn đường cho đoàn tàu đánh cá tìm về luồng lạch an toàn.",
                    "Nhìn ánh đèn bền bỉ giữa biển đêm, những người ngư dân thêm vững tay lái bởi họ biết quê hương luôn thức cùng mình nơi phía bờ xa.",
                ),
            ),
            ChildrenBookPageSpec(
                page_number=3,
                scene_motif="peaceful_harbor_dawn",
                paragraphs=(
                    "Sáng chủ nhật thanh bình, nhóm học sinh trường tiểu học trên đảo nhỏ được thầy giáo dẫn lên thăm trạm hải đăng ngập tràn gió biển.",
                    "Nghe bác Hải kể chuyện giữ đèn, bạn nhỏ nào cũng ánh lên niềm tự hào khi phóng tầm mắt ngắm nhìn lá cờ đỏ sao vàng tung bay giữa trời xanh.",
                    "Trong lòng các em thầm nảy nở ước mơ học tập thật giỏi để mai này góp sức dựng xây và gìn giữ biển trời Tổ quốc mãi mãi bình yên.",
                ),
            ),
        ),
    ),
)


def _resolve_vietnamese_font_paths() -> tuple[str | None, str | None]:
    """Locate regular and bold TrueType fonts with full Vietnamese Unicode coverage."""
    regular_candidates = [
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\tahoma.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    bold_candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\tahomabd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    reg = next((p for p in regular_candidates if os.path.isfile(p)), None)
    bold = next((p for p in bold_candidates if os.path.isfile(p)), reg)
    return reg, bold


def _load_font(path: str | None, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if path:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def _paint_soft_storybook_scene(
    width: int,
    height: int,
    *,
    palette: tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]],
    motif: str,
) -> Image.Image:
    """Paint a smooth, organic, strictly text-free watercolor-pastel illustration."""
    bg, mid, accent = palette
    # Build smooth vertical sky gradient in NumPy so there are zero sharp glyph-like edges
    top_rgb = np.array(bg, dtype=np.float32)
    bot_rgb = np.clip(top_rgb * 0.92 + np.array(mid, dtype=np.float32) * 0.08, 0, 255)
    t = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None, None]
    sky = np.round((1.0 - t) * top_rgb[None, None, :] + t * bot_rgb[None, None, :]).astype(
        np.uint8
    )
    sky = np.broadcast_to(sky, (height, width, 3)).copy()
    canvas = Image.fromarray(sky, mode="RGB")
    draw = ImageDraw.Draw(canvas)

    # Soft clouds (large smooth ellipses)
    cloud_col = (255, 255, 255)
    for cx, cy, rx, ry in (
        (0.22, 0.20, 0.13, 0.06),
        (0.30, 0.18, 0.10, 0.055),
        (0.74, 0.24, 0.14, 0.06),
    ):
        x0, y0 = int((cx - rx) * width), int((cy - ry) * height)
        x1, y1 = int((cx + rx) * width), int((cy + ry) * height)
        draw.ellipse((x0, y0, x1, y1), fill=cloud_col)

    # Sun or Moon depending on motif
    is_night = "moon" in motif or "night" in motif or "beam" in motif or "lantern" in motif
    orb_color = (253, 224, 71) if is_night else (251, 191, 36)
    orb_glow = (254, 243, 199)
    ox, oy, orad = int(width * 0.76), int(height * 0.22), int(min(width, height) * 0.13)
    draw.ellipse((ox - orad - 18, oy - orad - 18, ox + orad + 18, oy + orad + 18), fill=orb_glow)
    draw.ellipse((ox - orad, oy - orad, ox + orad, oy + orad), fill=orb_color)

    # Rolling horizon hills / ocean waves (large smooth arcs)
    hill_light = tuple(int(0.55 * mid[i] + 0.45 * bg[i]) for i in range(3))
    hill_mid = mid
    hill_deep = tuple(int(0.65 * accent[i] + 0.35 * mid[i]) for i in range(3))

    draw.ellipse(
        (-int(width * 0.25), int(height * 0.56), int(width * 0.78), int(height * 1.25)),
        fill=hill_light,
    )
    draw.ellipse(
        (int(width * 0.22), int(height * 0.60), int(width * 1.28), int(height * 1.30)),
        fill=hill_mid,
    )
    draw.ellipse(
        (-int(width * 0.15), int(height * 0.74), int(width * 1.15), int(height * 1.40)),
        fill=hill_deep,
    )

    # Motif-specific large focal object (always >= 16% of image height so zero components resemble text glyphs)
    if "lighthouse" in motif or "harbor" in motif:
        # Tall smooth lighthouse tower on left cliff
        tx0, tx1 = int(width * 0.24), int(width * 0.36)
        ty0, ty1 = int(height * 0.26), int(height * 0.74)
        draw.polygon(
            [(tx0 + 14, ty0), (tx1 - 14, ty0), (tx1, ty1), (tx0, ty1)],
            fill=(255, 255, 255),
        )
        draw.ellipse(
            (tx0 + 6, ty0 - 36, tx1 - 6, ty0 + 18),
            fill=(251, 191, 36),
        )
        # Warm light beam cone
        draw.polygon(
            [
                (tx1 - 8, ty0 - 10),
                (int(width * 0.92), int(height * 0.12)),
                (int(width * 0.92), int(height * 0.42)),
            ],
            fill=(254, 249, 195),
        )
    elif "sunflower" in motif or "garden" in motif or "sprout" in motif:
        # Large cheerful blooming flower in foreground
        fx, fy = int(width * 0.34), int(height * 0.48)
        stem_w = 22
        draw.rectangle(
            (fx - stem_w // 2, fy, fx + stem_w // 2, int(height * 0.80)),
            fill=(22, 163, 74),
        )
        petal_r = int(min(width, height) * 0.14)
        draw.ellipse(
            (fx - petal_r, fy - petal_r, fx + petal_r, fy + petal_r),
            fill=(250, 204, 21),
        )
        core_r = int(petal_r * 0.52)
        draw.ellipse(
            (fx - core_r, fy - core_r, fx + core_r, fy + core_r),
            fill=(146, 64, 14),
        )
    elif "lotus" in motif or "clouds" in motif or "rain" in motif:
        # Smooth lotus pad + soft pastel lotus blossom on tranquil pond
        px, py = int(width * 0.38), int(height * 0.68)
        draw.ellipse(
            (px - 170, py - 48, px + 170, py + 48),
            fill=(74, 222, 128),
        )
        draw.ellipse(
            (px - 85, py - 115, px + 85, py + 5),
            fill=(251, 207, 232),
        )
    elif "lantern" in motif or "autumn" in motif or "star" in motif:
        # Large glowing circular lantern halo in warm amber/coral
        lx, ly, lr = int(width * 0.36), int(height * 0.44), int(min(width, height) * 0.16)
        draw.ellipse((lx - lr - 22, ly - lr - 22, lx + lr + 22, ly + lr + 22), fill=(254, 240, 138))
        draw.ellipse((lx - lr, ly - lr, lx + lr, ly + lr), fill=(249, 115, 22))
        draw.ellipse((lx - lr // 2, ly - lr // 2, lx + lr // 2, ly + lr // 2), fill=(254, 249, 195))
    else:
        # Friendly rounded storybook tree / schoolhouse hill
        tx, ty = int(width * 0.32), int(height * 0.48)
        draw.rectangle((tx - 24, ty, tx + 24, int(height * 0.76)), fill=(180, 83, 9))
        canopy_r = int(min(width, height) * 0.17)
        draw.ellipse(
            (tx - canopy_r, ty - canopy_r, tx + canopy_r, ty + canopy_r // 2),
            fill=(74, 222, 128),
        )

    # Gentle watercolor softening so gradients blend naturally without crisp ink strokes
    return canvas.filter(ImageFilter.GaussianBlur(radius=2.2))


def _decode_webp_to_bgr(webp_bytes: bytes) -> np.ndarray:
    with Image.open(BytesIO(webp_bytes)) as decoded:
        rgb = np.asarray(decoded.convert("RGB"), dtype=np.uint8)
        return np.ascontiguousarray(rgb[:, :, ::-1])


def render_page_illustration_webp(
    spec: ChildrenBookSpec,
    page_spec: ChildrenBookPageSpec,
    *,
    ocr_check_fn: Any = None,
) -> tuple[bytes, int, int, str]:
    """Render & strictly verify a text-free WebP illustration for a book page."""
    img = _paint_soft_storybook_scene(
        ILLUST_WIDTH,
        ILLUST_HEIGHT,
        palette=spec.palette,
        motif=page_spec.scene_motif,
    )
    webp_bytes, out_w, out_h = _encode_optimized_webp(
        img, max_bytes=MAX_ILLUSTRATION_WEBP_BYTES
    )
    bgr = _decode_webp_to_bgr(webp_bytes)

    effective_ocr_fn = (
        _build_default_ocr_check_fn() if ocr_check_fn is None else ocr_check_fn
    )
    verification = verify_illustration_text_free(
        bgr,
        canonical_text=page_spec.canonical_text,
        ocr_check_fn=effective_ocr_fn,
        image_bytes=webp_bytes,
    )
    if not verification.text_free_verified:
        raise RuntimeError(
            f"Text-free gate rejected generated illustration for {spec.slug} page {page_spec.page_number}: {verification}"
        )
    asset_hash = hashlib.sha256(webp_bytes).hexdigest()
    return webp_bytes, out_w, out_h, asset_hash


def _wrap_tokens_to_lines(
    draw: ImageDraw.ImageDraw,
    tokens: list[str],
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    max_width_px: int,
) -> list[list[str]]:
    lines: list[list[str]] = []
    current: list[str] = []
    for tok in tokens:
        candidate = " ".join(current + [tok])
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if current and (bbox[2] - bbox[0]) > max_width_px:
            lines.append(current)
            current = [tok]
        else:
            current.append(tok)
    if current:
        lines.append(current)
    return lines


def render_book_cover_webp(spec: ChildrenBookSpec) -> tuple[bytes, int, int, str]:
    """Render a 900x1200 3:4 Vietnamese storybook cover and process via `validate_and_process_cover_image`."""
    w, h = 900, 1200
    base = _paint_soft_storybook_scene(w, h, palette=spec.palette, motif=spec.cover_motif)
    draw = ImageDraw.Draw(base)
    reg_path, bold_path = _resolve_vietnamese_font_paths()
    badge_font = _load_font(bold_path, 34)
    title_font = _load_font(bold_path, 58)
    author_font = _load_font(reg_path, 28)

    bg, mid, accent = spec.palette

    # Clean cream title card at top
    card_margin = 64
    draw.rounded_rectangle(
        (card_margin, 72, w - card_margin, 430),
        radius=36,
        fill=(255, 253, 248),
        outline=mid,
        width=6,
    )
    # Grade pill badge
    pill_w, pill_h = 210, 58
    px0 = (w - pill_w) // 2
    draw.rounded_rectangle(
        (px0, 100, px0 + pill_w, 100 + pill_h),
        radius=29,
        fill=accent,
    )
    grade_text = f"LỚP {spec.grade}"
    gb = draw.textbbox((0, 0), grade_text, font=badge_font)
    draw.text(
        ((w - (gb[2] - gb[0])) // 2, 100 + (pill_h - (gb[3] - gb[1])) // 2 - 4),
        grade_text,
        fill=(255, 255, 255),
        font=badge_font,
    )

    # Wrapped Book Title
    title_lines = _wrap_tokens_to_lines(
        draw, spec.title.split(), title_font, w - card_margin * 2 - 64
    )
    ty = 188
    for ln in title_lines[:3]:
        line_str = " ".join(ln)
        tb = draw.textbbox((0, 0), line_str, font=title_font)
        draw.text(
            ((w - (tb[2] - tb[0])) // 2, ty),
            line_str,
            fill=accent,
            font=title_font,
        )
        ty += 72

    # Bottom author ribbon
    draw.rounded_rectangle(
        (140, h - 126, w - 140, h - 58),
        radius=24,
        fill=(255, 253, 248),
        outline=mid,
        width=3,
    )
    author_label = "Tủ sách Thiếu nhi ViRead · 3 trang"
    ab = draw.textbbox((0, 0), author_label, font=author_font)
    draw.text(
        ((w - (ab[2] - ab[0])) // 2, h - 110),
        author_label,
        fill=accent,
        font=author_font,
    )

    png_buf = BytesIO()
    base.save(png_buf, format="PNG")
    processed = validate_and_process_cover_image(png_buf.getvalue(), "image/png")
    return (
        processed.webp_bytes,
        processed.width,
        processed.height,
        processed.asset_hash,
    )


def render_typeset_reading_page(
    spec: ChildrenBookSpec,
    page_spec: ChildrenBookPageSpec,
) -> dict[str, Any]:
    """Render a crisp 960x1280 reading page JPEG and measure exact word bounding boxes."""
    w, h = PAGE_IMAGE_WIDTH, PAGE_IMAGE_HEIGHT
    bg, mid, accent = spec.palette

    # Warm eye-friendly cream reading paper
    paper = Image.new("RGB", (w, h), (255, 252, 245))
    draw = ImageDraw.Draw(paper)

    # Decorative soft pastel border (strictly outside text margin, zero text inside header/footer so
    # the ONLY text on the page image is the exact reading passage!)
    draw.rounded_rectangle(
        (28, 28, w - 28, h - 28),
        radius=28,
        outline=mid,
        width=5,
    )
    # Top decorative banner with small soft illustration strip (text-free!)
    banner_h = 220
    banner_img = _paint_soft_storybook_scene(
        w - 96,
        banner_h,
        palette=spec.palette,
        motif=page_spec.scene_motif,
    )
    paper.paste(banner_img, (48, 48))

    reg_path, _bold_path = _resolve_vietnamese_font_paths()
    # Grade-scaled font sizes: larger type for younger grades, comfortable spacing for upper grades
    font_size_by_grade = {1: 38, 2: 35, 3: 32, 4: 30, 5: 29}
    line_step_by_grade = {1: 66, 2: 60, 3: 54, 4: 50, 5: 48}
    font_size = font_size_by_grade.get(spec.grade, 32)
    line_step = line_step_by_grade.get(spec.grade, 54)
    body_font = _load_font(reg_path, font_size)

    margin_x = 76
    max_text_w = w - margin_x * 2
    space_bbox = draw.textbbox((0, 0), " ", font=body_font)
    space_w = max(10, (space_bbox[2] - space_bbox[0]))

    cursor_y = 312
    word_index = 0
    line_index = 0
    paragraph_start_lines: list[int] = []
    measured_words: list[dict[str, Any]] = []
    canonical_paragraphs: list[str] = []

    for raw_para in page_spec.paragraphs:
        clean_para = unicodedata.normalize("NFC", raw_para.strip())
        if not clean_para:
            continue
        para_tokens = [tok for tok in clean_para.split() if tok]
        if not para_tokens:
            continue
        canonical_paragraphs.append(" ".join(para_tokens))
        paragraph_start_lines.append(line_index)

        wrapped_lines = _wrap_tokens_to_lines(draw, para_tokens, body_font, max_text_w)
        for p_line_idx, line_tokens in enumerate(wrapped_lines):
            cursor_x = margin_x + (28 if p_line_idx == 0 else 0)
            for tok in line_tokens:
                norm_tok = normalize_word(tok)
                if not norm_tok:
                    raise ValueError(
                        f"Token {tok!r} in {spec.slug} page {page_spec.page_number} normalized to empty"
                    )
                tb = draw.textbbox((cursor_x, cursor_y), tok, font=body_font)
                draw.text((cursor_x, cursor_y), tok, fill=(30, 41, 59), font=body_font)

                px0 = max(1, min(w - 4, int(tb[0]) - 2))
                py0 = max(1, min(h - 4, int(tb[1]) - 2))
                px1 = max(px0 + 4, min(w - 1, int(tb[2]) + 2))
                py1 = max(py0 + 4, min(h - 1, int(tb[3]) + 2))

                norm_bbox = [
                    round(px0 / float(w), 6),
                    round(py0 / float(h), 6),
                    round((px1 - px0) / float(w), 6),
                    round((py1 - py0) / float(h), 6),
                ]
                measured_words.append(
                    {
                        "word_index": word_index,
                        "line_index": line_index,
                        "text": tok,
                        "normalized_text": norm_tok,
                        "bbox": norm_bbox,
                        "ocr_confidence": 0.99,
                    }
                )
                word_index += 1
                cursor_x = int(tb[2]) + space_w
            line_index += 1
            cursor_y += line_step
        cursor_y += int(line_step * 0.42)

    if cursor_y > h - 44:
        raise ValueError(
            f"Typeset text overflowed page height ({cursor_y} > {h - 44}) on {spec.slug} page {page_spec.page_number}"
        )

    canonical_text = "\n\n".join(canonical_paragraphs)
    expected_tokens = normalize_text_tokens(canonical_text)
    actual_tokens = [w_item["normalized_text"] for w_item in measured_words]
    if expected_tokens != actual_tokens:
        raise ValueError(
            f"Normalized token mismatch in {spec.slug} page {page_spec.page_number}: {expected_tokens} != {actual_tokens}"
        )

    geometry_evidence = build_geometry_evidence(
        measured_words, w, h, reliable=True
    )
    if not has_verified_geometry(geometry_evidence, measured_words, w, h):
        raise ValueError(
            f"Word box geometry verification failed in {spec.slug} page {page_spec.page_number}"
        )

    jpg_buf = BytesIO()
    paper.save(jpg_buf, format="JPEG", quality=90, optimize=True)
    jpeg_bytes = jpg_buf.getvalue()
    image_sha256 = hashlib.sha256(jpeg_bytes).hexdigest()

    content_hash = hashlib.sha256(
        json.dumps(
            {"text": canonical_text, "words": measured_words},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    candidate_text = normalize_safety_text(canonical_text)
    candidate_hash = safety_content_hash(candidate_text)

    return {
        "page_number": page_spec.page_number,
        "jpeg_bytes": jpeg_bytes,
        "image_sha256": image_sha256,
        "width": w,
        "height": h,
        "canonical_text": canonical_text,
        "candidate_text": candidate_text,
        "candidate_hash": candidate_hash,
        "content_hash": content_hash,
        "words": measured_words,
        "geometry_evidence": geometry_evidence,
        "paragraph_start_line_indices": paragraph_start_lines,
        "indented_line_indices": paragraph_start_lines,
        "line_count": line_index,
    }


def build_complete_book_bundle(
    spec: ChildrenBookSpec,
    *,
    ocr_check_fn: Any = None,
) -> dict[str, Any]:
    """Deterministically build cover WebP, 3 page JPEGs, 3 text-free illustration WebPs, and verified metadata."""
    if len(spec.pages) != 3:
        raise ValueError(f"Book {spec.slug} must have exactly 3 pages, found {len(spec.pages)}")

    effective_ocr_fn = (
        _build_default_ocr_check_fn() if ocr_check_fn is None else ocr_check_fn
    )
    cover_webp, cover_w, cover_h, cover_hash = render_book_cover_webp(spec)
    page_bundles: list[dict[str, Any]] = []
    for page_spec in spec.pages:
        typeset = render_typeset_reading_page(spec, page_spec)
        ill_webp, ill_w, ill_h, ill_hash = render_page_illustration_webp(
            spec, page_spec, ocr_check_fn=effective_ocr_fn
        )
        typeset["illustration_webp"] = ill_webp
        typeset["illustration_width"] = ill_w
        typeset["illustration_height"] = ill_h
        typeset["illustration_hash"] = ill_hash
        page_bundles.append(typeset)

    return {
        "spec": spec,
        "cover_webp": cover_webp,
        "cover_width": cover_w,
        "cover_height": cover_h,
        "cover_hash": cover_hash,
        "pages": page_bundles,
    }
