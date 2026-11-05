"""Backend provider integrations."""
def __init__(self, api_key: str | None = None) -> None:
    self._api_key = api_key or os.getenv(
        "ELEVENLABS_API_KEY", ""
    ).strip()

    logger.info(
        "ElevenLabs API key loaded: %s, length: %d",
        bool(self._api_key),
        len(self._api_key),
    )