from __future__ import annotations


class OcrConfigurationError(RuntimeError):
    """A safe, server-side OCR provider configuration error."""


class OcrProviderError(RuntimeError):
    """A classified provider failure with no provider response/body attached."""

    def __init__(
        self,
        *,
        provider: str,
        code: str,
        status_code: int = 502,
        upstream_status_code: int | None = None,
        upstream_error_type: str | None = None,
        upstream_error_code: str | None = None,
        upstream_request_id: str | None = None,
        disables_family: bool = False,
    ) -> None:
        super().__init__(code)
        self.provider = provider
        self.code = code
        self.status_code = status_code
        self.upstream_status_code = upstream_status_code
        self.upstream_error_type = upstream_error_type
        self.upstream_error_code = upstream_error_code
        self.upstream_request_id = upstream_request_id
        self.disables_family = disables_family


class OcrOrchestrationError(RuntimeError):
    """No provider supplied a safe correction for the current document."""

    def __init__(self, code: str = "ALL_PROVIDERS_FAILED") -> None:
        super().__init__(code)
        self.code = code
