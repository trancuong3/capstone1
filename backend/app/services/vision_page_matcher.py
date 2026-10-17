#Kadepham
from __future__ import annotations

import cv2
import numpy as np
from typing import Any, Dict, List


class ViReadPageMatcher:
    def __init__(self) -> None:
        # Khởi tạo ORB với 1000 điểm đặc trưng (Keypoints) - Rất nhẹ và chạy nhanh trên CPU
        self.orb = cv2.ORB_create(nfeatures=1000)
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

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
        """
        nparr = np.frombuffer(camera_bytes, np.uint8)
        cam_gray = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
        if cam_gray is None:
            return {"matched": False, "confidence": 0.0}

        # Chuẩn hóa kích thước ảnh camera để tăng tốc độ trích xuất đặc trưng
        cam_h, cam_w = cam_gray.shape
        target_w = 800
        cam_resized = cv2.resize(cam_gray, (target_w, int(target_w * cam_h / max(cam_w, 1))))
        kp_cam, des_cam = self.orb.detectAndCompute(cam_resized, None)

        if des_cam is None or len(kp_cam) < 15:
            return {"matched": False, "confidence": 0.0}

        best_page = None
        best_inliers = 0
        best_confidence = 0.0

        for page in candidate_pages:
            raw_bytes = page.get("image_bytes")
            if not raw_bytes:
                continue

            db_arr = np.frombuffer(raw_bytes, np.uint8)
            db_gray = cv2.imdecode(db_arr, cv2.IMREAD_GRAYSCALE)
            if db_gray is None:
                continue

            db_h, db_w = db_gray.shape
            db_resized = cv2.resize(db_gray, (target_w, int(target_w * db_h / max(db_w, 1))))
            kp_db, des_db = self.orb.detectAndCompute(db_resized, None)

            if des_db is None or len(kp_db) < 15:
                continue

            matches = self.bf.knnMatch(des_cam, des_db, k=2)
            good_matches = []
            for pair in matches:
                if len(pair) == 2:
                    m, n = pair
                    if m.distance < 0.75 * n.distance:
                        good_matches.append(m)

            if len(good_matches) >= 10:
                src_pts = np.float32([kp_cam[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
                dst_pts = np.float32([kp_db[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)

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