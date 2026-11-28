#Kadepham
from __future__ import annotations

from collections import OrderedDict
import os
import threading
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np

DescriptorCacheKey = Tuple[str, str]
PageFeatures = Tuple[np.ndarray, np.ndarray]

DEFAULT_DESCRIPTOR_CACHE_MAX_ENTRIES = 256


def _resolve_cache_max_entries() -> int:
    raw = (os.getenv("VIREAD_MATCH_PAGE_CACHE_SIZE") or "").strip()
    if raw:
        try:
            return max(16, min(2048, int(raw)))
        except ValueError:
            pass
    return DEFAULT_DESCRIPTOR_CACHE_MAX_ENTRIES


class ViReadPageMatcher:
    def __init__(self, *, max_cache_entries: int | None = None) -> None:
        self._thread_local = threading.local()
        self._cache_lock = threading.Lock()
        self._cache_max_entries = (
            max_cache_entries
            if max_cache_entries is not None
            else _resolve_cache_max_entries()
        )
        self._descriptor_cache: OrderedDict[DescriptorCacheKey, PageFeatures] = OrderedDict()
        self._size_cache: Dict[DescriptorCacheKey, Tuple[int, int]] = {}
        self._cache_hits = 0
        self._cache_misses = 0
        # Retain attributes for any caller/test that inspects matcher.orb / matcher.bf.
        self.orb = cv2.ORB_create(nfeatures=1000)
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

    def _get_thread_detectors(self):
        orb = getattr(self._thread_local, "orb", None)
        bf = getattr(self._thread_local, "bf", None)
        if orb is None or bf is None:
            orb = cv2.ORB_create(nfeatures=1000)
            bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
            self._thread_local.orb = orb
            self._thread_local.bf = bf
        return orb, bf

    def clear_descriptor_cache(self) -> None:
        with self._cache_lock:
            self._descriptor_cache.clear()
            self._size_cache.clear()
            self._cache_hits = 0
            self._cache_misses = 0

    def cache_stats(self) -> Dict[str, int]:
        with self._cache_lock:
            return {
                "size": len(self._descriptor_cache),
                "max_entries": self._cache_max_entries,
                "hits": self._cache_hits,
                "misses": self._cache_misses,
            }

    def get_cached_features(self, cache_key: DescriptorCacheKey) -> PageFeatures | None:
        with self._cache_lock:
            entry = self._descriptor_cache.get(cache_key)
            if entry is not None:
                self._descriptor_cache.move_to_end(cache_key)
                self._cache_hits += 1
                return entry
            self._cache_misses += 1
            return None

    def get_cached_size(self, cache_key: DescriptorCacheKey) -> Tuple[int, int] | None:
        with self._cache_lock:
            return self._size_cache.get(cache_key)

    def _store_cached_features(
        self,
        cache_key: DescriptorCacheKey,
        features: PageFeatures,
        resized_size: Tuple[int, int] | None = None,
    ) -> None:
        with self._cache_lock:
            self._descriptor_cache[cache_key] = features
            if resized_size is not None:
                self._size_cache[cache_key] = resized_size
            self._descriptor_cache.move_to_end(cache_key)
            while len(self._descriptor_cache) > self._cache_max_entries:
                evicted_key, _ = self._descriptor_cache.popitem(last=False)
                self._size_cache.pop(evicted_key, None)

    def _extract_features_with_size(
        self, image_bytes: bytes
    ) -> Tuple[PageFeatures, Tuple[int, int]] | None:
        if not image_bytes:
            return None
        db_arr = np.frombuffer(image_bytes, np.uint8)
        db_gray = cv2.imdecode(db_arr, cv2.IMREAD_GRAYSCALE)
        if (
            db_gray is None
            or db_gray.size == 0
            or db_gray.ndim < 2
            or db_gray.shape[0] <= 0
            or db_gray.shape[1] <= 0
        ):
            return None

        db_h, db_w = db_gray.shape
        target_w = 800
        target_h = max(1, int(target_w * db_h / max(db_w, 1)))
        db_resized = cv2.resize(db_gray, (target_w, target_h))
        orb, _ = self._get_thread_detectors()
        kp_db, des_db = orb.detectAndCompute(db_resized, None)
        if des_db is None or len(kp_db) < 15:
            return None
        pts = np.array([kp.pt for kp in kp_db], dtype=np.float32)
        return (pts, np.ascontiguousarray(des_db)), (target_w, target_h)

    def extract_features(self, image_bytes: bytes) -> PageFeatures | None:
        """Compute lightweight ORB keypoint coordinates + uint8 descriptors (~40 KB/page)."""
        extracted = self._extract_features_with_size(image_bytes)
        if extracted is None:
            return None
        return extracted[0]

    def compute_and_cache_features(
        self, cache_key: DescriptorCacheKey, image_bytes: bytes
    ) -> PageFeatures | None:
        extracted = self._extract_features_with_size(image_bytes)
        if extracted is None:
            return None
        features, resized_size = extracted
        self._store_cached_features(cache_key, features, resized_size)
        return features

    def check_framing(self, image_bytes: bytes) -> Dict[str, Any]:
        """
        Kiểm tra sách đã đặt đúng vào khung trung tâm chưa, đủ sáng và không bị mờ (rung tay).
        """
        invalid_response = {
            "framing_valid": False,
            "status_code": "INVALID_IMAGE",
            "message": "Không đọc được hình ảnh từ camera. Bé thử lại nhé!",
        }
        if not image_bytes:
            return invalid_response
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if (
            img is None
            or img.size == 0
            or img.ndim < 2
            or img.shape[0] <= 0
            or img.shape[1] <= 0
        ):
            return invalid_response

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        h, w = gray.shape[:2]
        if h < 2 or w < 2:
            return invalid_response

        # 1. Kiểm tra ánh sáng
        brightness = float(np.mean(gray))
        if brightness < 45.0:
            return {
                "framing_valid": False,
                "status_code": "TOO_DARK",
                "message": "Hơi tối rồi, bé bật thêm đèn hoặc đặt sách nơi sáng hơn nhé!",
            }

        # 2. Kiểm tra độ nét (chống rung tay khi đặt sách)
        blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if blur_score < 45.0:
            return {
                "framing_valid": False,
                "status_code": "TOO_BLURRY",
                "message": "Hình hơi mờ, bé giữ yên trang sách trong khung 1 giây nhé!",
            }

        # 3. Kiểm tra vùng khung đặt sách (ROI 70% ở trung tâm khung hình)
        roi_y1, roi_y2 = int(h * 0.15), int(h * 0.85)
        roi_x1, roi_x2 = int(w * 0.15), int(w * 0.85)
        roi = gray[roi_y1:roi_y2, roi_x1:roi_x2]
        if roi.size == 0:
            return invalid_response

        edges = cv2.Canny(roi, 50, 150)
        edge_density = float(np.count_nonzero(edges)) / float(roi.size)

        if edge_density < 0.012:
            return {
                "framing_valid": False,
                "status_code": "OUT_OF_FRAME",
                "message": "Chưa thấy trang sách trong khung. Bé đặt sách nằm gọn vào khung viền nhé!",
            }

        return {
            "framing_valid": True,
            "status_code": "FRAME_OK",
            "message": "Sách đã vào đúng khung! Đang nhận diện trang sách...",
        }

    def match_page(
        self, camera_bytes: bytes, candidate_pages: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Đối chiếu ảnh từ camera với tất cả các trang của cuốn sách đã chọn bằng ORB + Homography.
        Hỗ trợ sẵn `features` đã cache (tránh giải mã/tải lại ảnh) và giữ tương thích với `image_bytes`.
        """
        if not camera_bytes:
            return {"matched": False, "confidence": 0.0}
        nparr = np.frombuffer(camera_bytes, np.uint8)
        cam_gray = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
        if (
            cam_gray is None
            or cam_gray.size == 0
            or cam_gray.ndim < 2
            or cam_gray.shape[0] <= 0
            or cam_gray.shape[1] <= 0
        ):
            return {"matched": False, "confidence": 0.0}

        cam_h, cam_w = cam_gray.shape
        target_w = 800
        cam_rh = max(1, int(target_w * cam_h / max(cam_w, 1)))
        cam_resized = cv2.resize(cam_gray, (target_w, cam_rh))
        orb, bf = self._get_thread_detectors()
        kp_cam, des_cam = orb.detectAndCompute(cam_resized, None)

        if des_cam is None or len(kp_cam) < 15:
            return {"matched": False, "confidence": 0.0}

        cam_pts = np.array([kp.pt for kp in kp_cam], dtype=np.float32)

        best_page = None
        best_inliers = 0
        best_confidence = 0.0
        best_homography: np.ndarray | None = None
        best_db_size: Tuple[int, int] | None = None

        for page in candidate_pages:
            features = page.get("features")
            db_size = page.get("db_resized_size")
            cache_key = page.get("cache_key")
            valid_cache_key = isinstance(cache_key, tuple) and len(cache_key) == 2

            if features is None:
                if valid_cache_key:
                    features = self.get_cached_features(cache_key)
                    if db_size is None:
                        db_size = self.get_cached_size(cache_key)
                if features is None:
                    raw_bytes = page.get("image_bytes")
                    if not raw_bytes:
                        continue
                    extracted = self._extract_features_with_size(raw_bytes)
                    if extracted is not None:
                        features, db_size = extracted
                        if valid_cache_key:
                            self._store_cached_features(cache_key, features, db_size)
            elif db_size is None and valid_cache_key:
                db_size = self.get_cached_size(cache_key)

            if features is None:
                continue

            if not (
                isinstance(db_size, tuple)
                and len(db_size) == 2
                and db_size[0] > 0
                and db_size[1] > 0
            ):
                page_orm = page.get("page_orm")
                pw = max(1, int(getattr(page_orm, "Width", 1000) or 1000))
                ph = max(1, int(getattr(page_orm, "Height", 1400) or 1400))
                db_size = (800, max(1, int(800 * ph / pw)))

            pts_db, des_db = features
            if des_db is None or len(pts_db) < 15:
                continue

            matches = bf.knnMatch(des_cam, des_db, k=2)
            good_matches = []
            for pair in matches:
                if len(pair) == 2:
                    m, n = pair
                    if m.distance < 0.75 * n.distance:
                        good_matches.append(m)

            if len(good_matches) >= 10:
                src_pts = np.float32(
                    [cam_pts[m.queryIdx] for m in good_matches]
                ).reshape(-1, 1, 2)
                dst_pts = np.float32(
                    [pts_db[m.trainIdx] for m in good_matches]
                ).reshape(-1, 1, 2)

                homography, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
                if mask is not None:
                    inliers = int(np.sum(mask))
                    confidence = min(1.0, round(inliers / 40.0, 2))
                    if inliers > best_inliers:
                        best_inliers = inliers
                        best_confidence = confidence
                        best_page = page
                        best_homography = homography
                        best_db_size = db_size

        # Ngưỡng xác nhận khớp trang: tối thiểu 12 điểm khớp đồng phẳng (inliers)
        if best_page is not None and best_inliers >= 12:
            return {
                "matched": True,
                "confidence": max(0.75, best_confidence),
                "page": best_page,
                "homography_cam_to_db": best_homography,
                "cam_resized_size": (target_w, cam_rh),
                "db_resized_size": best_db_size,
            }

        return {
            "matched": False,
            "confidence": best_confidence,
        }


def _signed_quad_area(pts: np.ndarray) -> float:
    """Signed shoelace area in image coordinates (clockwise (0,0)->(1,0)->(1,1)->(0,1) > 0)."""
    x = pts[:, 0]
    y = pts[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _project_norm_quad(
    h_inv: np.ndarray,
    corners: list[tuple[float, float]],
    *,
    min_coord: float,
    max_coord: float,
    min_area: float,
    max_area: float,
) -> list[tuple[float, float]] | None:
    homog = np.array([[c[0], c[1], 1.0] for c in corners], dtype=np.float64).T
    projected_h = h_inv @ homog
    denom = projected_h[2, :]
    if not np.all(np.isfinite(projected_h)) or np.any(denom <= 1e-4):
        return None

    pts = (projected_h[:2, :] / denom).T.astype(np.float64)
    if not np.all(np.isfinite(pts)):
        return None
    if np.any(pts < min_coord) or np.any(pts > max_coord):
        return None

    signed_area = _signed_quad_area(pts)
    if signed_area <= 0.0:
        return None

    quad_i32 = np.round(pts * 10000.0).astype(np.int32).reshape(-1, 1, 2)
    if not bool(cv2.isContourConvex(quad_i32)):
        return None

    area = float(cv2.contourArea(pts.astype(np.float32).reshape(-1, 1, 2)))
    if not (min_area <= area <= max_area):
        return None

    return [(round(float(px), 5), round(float(py), 5)) for px, py in pts]


def project_page_lines_to_camera(
    homography_cam_to_db: np.ndarray | None,
    *,
    cam_size: Tuple[int, int] | None,
    db_size: Tuple[int, int] | None,
    words: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Project verified page line boxes into normalized [0..1] camera space via H_norm^{-1}."""
    empty: Dict[str, Any] = {
        "homography_matrix": None,
        "page_quad": None,
        "spotlight_lines": [],
    }
    if (
        homography_cam_to_db is None
        or not isinstance(homography_cam_to_db, np.ndarray)
        or homography_cam_to_db.shape != (3, 3)
        or cam_size is None
        or db_size is None
    ):
        return empty

    cam_w, cam_h = int(cam_size[0]), int(cam_size[1])
    db_w, db_h = int(db_size[0]), int(db_size[1])
    if cam_w <= 0 or cam_h <= 0 or db_w <= 0 or db_h <= 0:
        return empty

    h_mat = homography_cam_to_db.astype(np.float64)
    if not np.all(np.isfinite(h_mat)):
        return empty

    s_cam = np.array(
        [[float(cam_w), 0.0, 0.0], [0.0, float(cam_h), 0.0], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    s_db_inv = np.array(
        [[1.0 / float(db_w), 0.0, 0.0], [0.0, 1.0 / float(db_h), 0.0], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    h_norm = s_db_inv @ h_mat @ s_cam
    if not np.all(np.isfinite(h_norm)) or abs(float(h_norm[2, 2])) <= 1e-8:
        return empty

    h_norm = h_norm / float(h_norm[2, 2])
    det_h = float(np.linalg.det(h_norm))
    if not np.isfinite(det_h) or det_h < 1e-4 or det_h > 1e4:
        return empty

    try:
        cond_h = float(np.linalg.cond(h_norm))
        if not np.isfinite(cond_h) or cond_h >= 1e5:
            return empty
        h_inv = np.linalg.inv(h_norm)
    except np.linalg.LinAlgError:
        return empty

    if not np.all(np.isfinite(h_inv)) or abs(float(h_inv[2, 2])) <= 1e-8:
        return empty
    h_inv = h_inv / float(h_inv[2, 2])

    page_quad = _project_norm_quad(
        h_inv,
        [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
        min_coord=-0.75,
        max_coord=1.75,
        min_area=1e-4,
        max_area=4.0,
    )
    if page_quad is None:
        return empty

    by_line: Dict[int, List[Dict[str, Any]]] = {}
    for w in words:
        line_idx = max(0, int(w.get("line_index", 0) or 0))
        by_line.setdefault(line_idx, []).append(w)

    spotlight_lines: List[Dict[str, Any]] = []
    for line_idx in sorted(by_line.keys()):
        line_words = sorted(
            by_line[line_idx], key=lambda item: int(item.get("word_index", 0) or 0)
        )
        xs0: List[float] = []
        ys0: List[float] = []
        xs1: List[float] = []
        ys1: List[float] = []
        tokens: List[str] = []
        for item in line_words:
            bbox = item.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            bx, by, bw, bh = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
            if (
                not (np.isfinite(bx) and np.isfinite(by) and np.isfinite(bw) and np.isfinite(bh))
                or bw <= 0.0
                or bh <= 0.0
                or bx < -0.05
                or by < -0.05
                or bx + bw > 1.05
                or by + bh > 1.05
            ):
                continue
            xs0.append(max(0.0, min(1.0, bx)))
            ys0.append(max(0.0, min(1.0, by)))
            xs1.append(max(0.0, min(1.0, bx + bw)))
            ys1.append(max(0.0, min(1.0, by + bh)))
            tok = str(item.get("text") or "").strip()
            if tok:
                tokens.append(tok)

        if not xs0 or not tokens:
            continue
        x0, y0, x1, y1 = min(xs0), min(ys0), max(xs1), max(ys1)
        if x1 - x0 <= 1e-4 or y1 - y0 <= 1e-4:
            continue

        quad = _project_norm_quad(
            h_inv,
            [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
            min_coord=-0.5,
            max_coord=1.5,
            min_area=1e-6,
            max_area=1.0,
        )
        if quad is None:
            continue
        spotlight_lines.append(
            {
                "line_index": line_idx,
                "text": " ".join(tokens),
                "word_count": len(tokens),
                "points": quad,
            }
        )

    return {
        "homography_matrix": [round(float(v), 6) for v in h_inv.reshape(-1)],
        "page_quad": page_quad,
        "spotlight_lines": spotlight_lines,
    }


vision_page_matcher = ViReadPageMatcher()
