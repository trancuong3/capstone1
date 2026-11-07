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
        disables_family: bool = False,
    ) -> None:
        super().__init__(code)
        self.provider = provider
        self.code = code
        self.status_code = status_code
        self.disables_family = disables_family


class OcrOrchestrationError(RuntimeError):
    """No provider supplied a safe correction for the current document."""

    def __init__(self, code: str = "ALL_PROVIDERS_FAILED") -> None:
        super().__init__(code)
        self.code = code
