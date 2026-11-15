"""Private karaoke bucket adapter; never accepts legacy/external object URLs."""
import logging
import re
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException

from app.database.config import SUPABASE_URL
from app.database.supabase_client import get_supabase_admin_client

logger = logging.getLogger(__name__)
BUCKET = "viread-karaoke"
URL_TTL = 3600
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_PATH = re.compile(rf"songs/({_UUID})/versions/{_UUID}/(?:audio/{_UUID}\.mp3|covers/{_UUID}\.webp)\Z")


class KaraokeStorage:
    @staticmethod
    def validate_path(path, song_id):
        match = _PATH.fullmatch(path) if isinstance(path, str) else None
        if not match or match.group(1) != str(song_id):
            raise HTTPException(503, "Karaoke media reference is invalid")

    @staticmethod
    def _bucket():
        client = get_supabase_admin_client()
        if client is None:
            raise RuntimeError("Storage is not configured")
        return client.storage.from_(BUCKET)

    def upload(self, path, song_id, data, content_type):
        self.validate_path(path, song_id)
        try:
            self._bucket().upload(path, data, file_options={
                "content-type": content_type, "upsert": "false",
            })
        except Exception:
            logger.warning("karaoke_storage_upload_failed")
            raise HTTPException(503, "Karaoke media could not be saved") from None

    def verify(self, path, song_id, expected_size=None):
        self.validate_path(path, song_id)
        try:
            info = self._bucket().info(path)
            if not isinstance(info, dict) or not info:
                raise ValueError("Storage object unavailable")
            metadata = info.get("metadata", {})
            if not isinstance(metadata, dict):
                metadata = {}
            # The info endpoint uses top-level size; older Storage responses
            # expose the value under metadata. Both must be checked, not skipped.
            size = info.get("size", info.get("content_length", metadata.get("size")))
            if isinstance(size, bool) or size is None or int(size) < 1:
                raise ValueError("Missing Storage object size")
            if expected_size is not None and int(size) != expected_size:
                raise ValueError("Storage object size mismatch")
            mime = info.get("content_type") or info.get("contentType") or metadata.get("mimetype")
            expected_mime = "audio/mpeg" if path.endswith(".mp3") else "image/webp"
            if mime is not None and str(mime).split(";")[0].strip().lower() != expected_mime:
                raise ValueError("Storage content type mismatch")
        except Exception:
            logger.warning("karaoke_storage_verification_failed")
            raise HTTPException(503, "Karaoke media is unavailable") from None

    def sign(self, path, song_id):
        self.validate_path(path, song_id)
        try:
            result = self._bucket().create_signed_url(path, URL_TTL)
            signed = result.get("signedURL") or result.get("signedUrl") or result.get("signed_url")
            if not isinstance(signed, str) or not signed:
                raise ValueError("Missing signed URL")
            base = (SUPABASE_URL or "").rstrip("/")
            if signed.startswith("/storage/v1/"):
                signed = base + signed
            elif signed.startswith("/object/sign/"):
                signed = base + "/storage/v1" + signed
            url, origin = urlsplit(signed), urlsplit(base)
            if (url.scheme not in {"http", "https"} or url.scheme != origin.scheme
                    or url.netloc != origin.netloc or url.username or url.password
                    or unquote(url.path) != f"/storage/v1/object/sign/{BUCKET}/{path}"
                    or not url.query or url.fragment):
                raise ValueError("Unexpected signed URL origin")
            return signed
        except Exception:
            logger.warning("karaoke_storage_sign_failed")
            raise HTTPException(503, "Karaoke media link is unavailable") from None

    def remove(self, path, song_id):
        self.validate_path(path, song_id)
        try:
            self._bucket().remove([path])
        except Exception:
            logger.warning("karaoke_orphan_cleanup_failed")
