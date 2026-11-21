from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PresenceSettingsRead(BaseModel):
    email_enabled: bool = Field(
        description="Parent opted in to the 'nobody in frame' email. Off by default."
    )


class PresenceSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email_enabled: bool


class PresenceAlertArm(BaseModel):
    """What the client may say. The recipient, timings and limits are server-side.

    There is deliberately no email, address, image, audio or transcript field:
    unknown fields are rejected.
    """

    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    episode_id: UUID = Field(
        description="Client-generated id of one continuous absence; makes arming idempotent."
    )


PresenceAlertStatus = Literal[
    "PENDING", "SENDING", "SENT", "CANCELLED", "EXPIRED", "FAILED"
]


class PresenceAlertRead(BaseModel):
    id: UUID
    session_id: UUID
    episode_id: UUID
    status: PresenceAlertStatus
    due_at: datetime
    expires_at: datetime
    cancel_reason: str | None = None


class PresenceAlertCancel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Literal[
        "RETURNED", "SESSION_ENDED", "APP_BACKGROUND", "OPT_OUT", "PAUSED_BY_PARENT"
    ] = "RETURNED"
