from __future__ import annotations

from datetime import datetime, timezone

from app.providers.support_email_provider import SupportEmailProvider
from app.schemas.support import SupportFeedbackRequest

CATEGORY_LABELS: dict[str, str] = {
    "technical_issue": "Báo lỗi kỹ thuật",
    "feature_feedback": "Góp ý cải thiện tính năng",
    "account_support": "Yêu cầu hỗ trợ tài khoản",
    "how_to": "Hỏi đáp sử dụng ViRead",
    "feature_request": "Đề xuất tính năng mới",
    "other": "Khác",
}


class SupportService:
    """Format support requests and coordinate the external SMTP provider."""

    def __init__(self, email_provider: SupportEmailProvider | None = None):
        self.email_provider = email_provider or SupportEmailProvider()

    async def submit_feedback(self, request: SupportFeedbackRequest) -> None:
        category_label = CATEGORY_LABELS[request.category]
        submitted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        email_subject = f"[ViRead Support] {category_label} - {request.subject}"
        email_body = "\n".join(
            [
                "Sản phẩm: ViRead",
                f"Loại yêu cầu: {category_label}",
                f"Tiêu đề: {request.subject}",
                f"Email liên hệ: {request.contact_email}",
                f"Thời điểm tiếp nhận (UTC): {submitted_at}",
                "",
                "Nội dung phản hồi:",
                request.message,
                "",
                "Email này được gửi từ biểu mẫu Trợ giúp & hỗ trợ của ViRead.",
            ]
        )

        await self.email_provider.send(
            subject=email_subject,
            body=email_body,
            reply_to=str(request.contact_email),
        )
