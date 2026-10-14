"""Request correlation ID context shared by API services and worker threads."""
from contextvars import ContextVar

request_id_context: ContextVar[str] = ContextVar("readalong_request_id", default="-")


def get_request_id() -> str:
    """Return the current request ID, or '-' outside an HTTP request."""
    return request_id_context.get()
