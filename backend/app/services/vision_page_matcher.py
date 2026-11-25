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

    def _store_cached_features(
        self, cache_key: DescriptorCacheKey, features: PageFeatures
    ) -> None:
        with self._cache_lock:
            self._descriptor_cache[cache_key] = features
            self._descriptor_cache.move_to_end(cache_key)
            while len(self._descriptor_cache) > self._cache_max_entries:
                self._descriptor_cache.popitem(last=False)

    def extract_features(self, image_bytes: bytes) -> PageFeatures | None:
        """Compute lightweight ORB keypoint coordinates + uint8 descriptors (~40 KB/page)."""
        if not image_bytes:
            return None
        db_arr = np.frombuffer(image_bytes, np.uint8)
        db_gray = cv2.imdecode(db_arr, cv2.IMREAD_GRAYSCALE)
        if db_gray is None:
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
        return pts, np.ascontiguousarray(des_db)

    def compute_and_cache_features(
        self, cache_key: DescriptorCacheKey, image_bytes: bytes
    ) -> PageFeatures | None:
        features = self.extract_features(image_bytes)
        if features is not None:
            self._store_cached_features(cache_key, features)
        return features

    def check_framing(self, image_bytes: bytes) -> Dict[str, Any]:
        """
        Kiểm tra sách đã đặt đúng vào khung trung tâm chưa, đủ sáng và không bị mờ (rung tay).
        """
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return {
                "framing_valid": False,
                "status_code": "INVALID_IMAGE",
                "message": "Không đọc được hình ảnh từ camera. Bé thử lại nhé!",
            }

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape

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
        nparr = np.frombuffer(camera_bytes, np.uint8)
        cam_gray = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
        if cam_gray is None:
            return {"matched": False, "confidence": 0.0}

        cam_h, cam_w = cam_gray.shape
        target_w = 800
        cam_resized = cv2.resize(
            cam_gray, (target_w, max(1, int(target_w * cam_h / max(cam_w, 1))))
        )
        orb, bf = self._get_thread_detectors()
        kp_cam, des_cam = orb.detectAndCompute(cam_resized, None)

        if des_cam is None or len(kp_cam) < 15:
            return {"matched": False, "confidence": 0.0}

        cam_pts = np.array([kp.pt for kp in kp_cam], dtype=np.float32)

        best_page = None
        best_inliers = 0
        best_confidence = 0.0

        for page in candidate_pages:
            features = page.get("features")
            if features is None:
                cache_key = page.get("cache_key")
                if (
                    isinstance(cache_key, tuple)
                    and len(cache_key) == 2
                ):
                    features = self.get_cached_features(cache_key)
                if features is None:
                    raw_bytes = page.get("image_bytes")
                    if not raw_bytes:
                        continue
                    features = self.extract_features(raw_bytes)
                    if (
                        features is not None
                        and isinstance(cache_key, tuple)
                        and len(cache_key) == 2
                    ):
                        self._store_cached_features(cache_key, features)

            if features is None:
                continue

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

                _, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
                if mask is not None:
                    inliers = int(np.sum(mask))
                    confidence = min(1.0, round(inliers / 40.0, 2))
                    if inliers > best_inliers:
                        best_inliers = inliers
                        best_confidence = confidence
                        best_page = page

        # Ngưỡng xác nhận khớp trang: tối thiểu 12 điểm khớp đồng phẳng (inliers)
        if best_page is not None and best_inliers >= 12:
            return {
                "matched": True,
                "confidence": max(0.75, best_confidence),
                "page": best_page,
            }

        return {
            "matched": False,
            "confidence": best_confidence,
        }


vision_page_matcher = ViReadPageMatcher()
