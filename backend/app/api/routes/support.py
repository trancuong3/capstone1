from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict

from app.api.deps import get_current_parent_id
from app.providers.support_email_provider import (
    SupportEmailDeliveryError,
    SupportEmailNotConfiguredError,
)
from app.schemas.support import SupportFeedbackRequest
from app.services.support_service import SupportService

logger = logging.getLogger(__name__)
router = APIRouter()


class SupportFeedbackResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: Literal[True]
    delivery_status: Literal["accepted_by_smtp"]
    detail: str


@router.post(
    "/feedback",
    response_model=SupportFeedbackResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_support_feedback(
    request: SupportFeedbackRequest,
    _parent_id: UUID = Depends(get_current_parent_id),
) -> SupportFeedbackResponse:
    """Send authenticated parent feedback to the backend-configured inbox."""
    try:
        await SupportService().submit_feedback(request)
    except SupportEmailNotConfiguredError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Support email service is not configured",
        ) from None
    except SupportEmailDeliveryError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Support email service is temporarily unavailable",
        ) from None
    except Exception as error:
        logger.error(
            "Support submission failed (exception_type=%s)",
            type(error).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Support email service is temporarily unavailable",
        ) from None

    return SupportFeedbackResponse(
        accepted=True,
        delivery_status="accepted_by_smtp",
        detail="The SMTP server accepted the support message.",
    )
