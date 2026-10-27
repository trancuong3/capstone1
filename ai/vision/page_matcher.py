import cv2
import numpy as np
from typing import List, Dict, Any, Optional

class ViReadPageMatcher:
    def __init__(self):
        # Khởi tạo ORB detector với 1000 keypoints để cân bằng tốc độ và độ chính xác
        self.orb = cv2.ORB_create(nfeatures=1000)
        # Sử dụng Brute-Force Matcher với khoảng cách Hamming cho ORB
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

    def check_framing_and_quality(self, image_bytes: bytes) -> Dict[str, Any]:
        """
        Kiểm tra xem ảnh từ camera có bị mờ không và sách đã đặt vào vùng trung tâm chưa.
        """
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return {"is_valid": False, "reason": "INVALID_IMAGE", "message": "Không đọc được hình ảnh từ camera."}

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape

        # 1. Kiểm tra độ nét (Blur Detection) bằng phương sai Laplacian
        blur_score = cv2.Laplacian(gray, cv2.CV_64F).var()
        if blur_score < 60.0:  # Ngưỡng mờ (có thể tinh chỉnh khi test thực tế)
            return {
                "is_valid": False,
                "reason": "TOO_BLURRY",
                "blur_score": round(blur_score, 2),
                "message": "Ảnh hơi mờ, bé giữ yên sách một chút nhé!"
            }

        # 2. Kiểm tra độ sáng (Brightness)
        brightness = np.mean(gray)
        if brightness < 50:
            return {
                "is_valid": False,
                "reason": "TOO_DARK",
                "message": "Hơi tối rồi, bé bật thêm đèn hoặc đưa sách ra chỗ sáng nhé!"
            }

        # 3. Kiểm tra mật độ chi tiết trong vùng khung trung tâm (ROI - Region of Interest)
        # Giả sử khung đặt sách chiếm 70% diện tích giữa màn hình
        roi_y1, roi_y2 = int(h * 0.15), int(h * 0.85)
        roi_x1, roi_x2 = int(w * 0.15), int(w * 0.85)
        roi = gray[roi_y1:roi_y2, roi_x1:roi_x2]

        # Dùng Canny Edge để xem trong khung có nội dung (chữ/hình vẽ) hay chỉ là nền trống
        edges = cv2.Canny(roi, 50, 150)
        edge_density = np.count_nonzero(edges) / float(roi.size)

        if edge_density < 0.015:
            return {
                "is_valid": False,
                "reason": "OUT_OF_FRAME",
                "edge_density": round(edge_density, 4),
                "message": "Chưa thấy trang sách trong khung. Bé đặt sách vào giữa khung hình nhé!"
            }

        return {
            "is_valid": True,
            "reason": "OK",
            "blur_score": round(blur_score, 2),
            "edge_density": round(edge_density, 4),
            "message": "Đã đặt sách đúng khung! Đang nhận diện trang..."
        }

    def compute_orb_features(self, img_gray: np.ndarray):
        """Trích xuất keypoints và descriptors từ ảnh xám"""
        kp, des = self.orb.detectAndCompute(img_gray, None)
        return kp, des

    def match_camera_to_pages(
        self, 
        camera_image_bytes: bytes, 
        candidate_pages: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        So sánh ảnh chụp từ camera với danh sách các trang sách trong DB.
        candidate_pages: List[{"page_id": UUID, "page_number": int, "image_bytes": bytes, ...}]
        """
        # Giải mã ảnh từ camera và cắt lấy vùng trung tâm (ROI)
        nparr = np.frombuffer(camera_image_bytes, np.uint8)
        cam_img = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
        
        if cam_img is None:
            return {"matched": False, "message": "Lỗi giải mã ảnh camera."}

        # Resize ảnh chuẩn hóa để tăng tốc độ xử lý
        cam_img = cv2.resize(cam_img, (800, int(800 * cam_img.shape[0] / cam_img.shape[1])))
        kp_cam, des_cam = self.compute_orb_features(cam_img)

        if des_cam is None or len(kp_cam) < 20:
            return {"matched": False, "message": "Không tìm thấy đủ điểm đặc trưng trên trang sách."}

        best_match = None
        highest_inliers = 0
        best_confidence = 0.0

        for page in candidate_pages:
            page_bytes = page.get("image_bytes")
            if not page_bytes:
                continue

            page_arr = np.frombuffer(page_bytes, np.uint8)
            db_img = cv2.imdecode(page_arr, cv2.IMREAD_GRAYSCALE)
            if db_img is None:
                continue

            db_img = cv2.resize(db_img, (800, int(800 * db_img.shape[0] / db_img.shape[1])))
            kp_db, des_db = self.compute_orb_features(db_img)

            if des_db is None or len(kp_db) < 20:
                continue

            # Tìm 2 điểm gần nhất bằng KNN
            matches = self.bf.knnMatch(des_cam, des_db, k=2)

            # Lọc các điểm khớp tốt theo Lowe's ratio test (0.75)
            good_matches = []
            for m_n in matches:
                if len(m_n) == 2:
                    m, n = m_n
                    if m.distance < 0.75 * n.distance:
                        good_matches.append(m)

            # Nếu có ít nhất 12 điểm khớp tốt, kiểm tra hình học bằng Homography (RANSAC)
            if len(good_matches) >= 12:
                src_pts = np.float32([kp_cam[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
                dst_pts = np.float32([kp_db[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)

                _, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
                if mask is not None:
                    inliers = int(np.sum(mask))
                    # Tính điểm tin cậy (Confidence Score) chuẩn hóa từ [0.0 -> 1.0]
                    confidence = min(1.0, inliers / 45.0) 

                    if inliers > highest_inliers:
                        highest_inliers = inliers
                        best_confidence = round(confidence, 3)
                        best_match = page

        # Ngưỡng tối thiểu để xác nhận đúng trang là có >= 15 điểm khớp chuẩn hình học (inliers)
        if best_match and highest_inliers >= 15:
            return {
                "matched": True,
                "page_id": best_match["page_id"],
                "page_number": best_match["page_number"],
                "revision_id": best_match.get("revision_id"),
                "confidence": best_confidence,
                "inliers": highest_inliers,
                "message": f"Đã nhận diện thành công Trang {best_match['page_number']}!"
            }

        return {
            "matched": False,
            "confidence": best_confidence,
            "message": "Chưa nhận ra trang nào. Bé hãy đặt sách thẳng hơn hoặc chọn trang thủ công nhé!"
        }

# Singleton instance
page_matcher_engine = ViReadPageMatcher()