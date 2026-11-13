from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from typing import Any
from urllib.parse import urlencode

import requests

EXECUTION_ID_RE = re.compile(r"^vr-[a-f0-9]{32}-[1-9][0-9]*$")
COMMIT_RE = re.compile(r"^[a-f0-9]{40}$")


class ColabEnterpriseConfigurationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ColabEnterpriseDispatchError(RuntimeError):
    def __init__(self, code: str, *, retryable: bool):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def _canonical_request(timestamp: str, method: str, path: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return f"{timestamp}\n{method.upper()}\n{path}\n{body_hash}".encode("utf-8")


def _signature(secret: str, timestamp: str, method: str, path: str, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), _canonical_request(
        timestamp, method, path, body), hashlib.sha256).hexdigest()


def enterprise_configuration(env: dict[str, str] | None = None) -> dict[str, str]:
    source = os.environ if env is None else env
    mode = source.get("VIREAD_COLAB_EXECUTION_MODE", "enterprise").strip().lower()
    if mode not in {"enterprise", "manual", "disabled"}:
        raise ColabEnterpriseConfigurationError("COLAB_EXECUTION_MODE_INVALID")
    if mode != "enterprise":
        return {"mode": mode}
    dispatch_url = source.get("VIREAD_COLAB_DISPATCH_URL", "").strip().rstrip("/")
    shared_secret = source.get("VIREAD_COLAB_DISPATCH_SHARED_SECRET", "").strip()
    repository_url = source.get("VIREAD_COLAB_REPOSITORY_URL", "").strip()
    repository_commit = source.get("VIREAD_COLAB_REPOSITORY_COMMIT", "").strip().lower()
    if not dispatch_url or not dispatch_url.startswith("https://"):
        raise ColabEnterpriseConfigurationError("COLAB_DISPATCH_URL_MISSING_OR_NOT_HTTPS")
    if len(shared_secret) < 32:
        raise ColabEnterpriseConfigurationError("COLAB_DISPATCH_SECRET_MISSING_OR_TOO_SHORT")
    if not repository_url.startswith("https://github.com/"):
        raise ColabEnterpriseConfigurationError("COLAB_REPOSITORY_URL_INVALID")
    if not COMMIT_RE.fullmatch(repository_commit):
        raise ColabEnterpriseConfigurationError("COLAB_REPOSITORY_COMMIT_NOT_PINNED")
    return {"mode": mode, "dispatch_url": dispatch_url, "shared_secret": shared_secret,
            "repository_url": repository_url, "repository_commit": repository_commit}


class ColabEnterpriseDispatcher:
    def __init__(self, config: dict[str, str], *, session: Any | None = None,
                 timeout_seconds: int = 30):
        self.config = config
        self.session = session or requests.Session()
        self.timeout_seconds = timeout_seconds

    def _request(self, method: str, path: str, body: bytes = b"") -> dict[str, Any]:
        timestamp = str(int(time.time()))
        signature = _signature(self.config["shared_secret"], timestamp, method, path, body)
        headers = {"X-ViRead-Timestamp": timestamp, "X-ViRead-Signature": signature,
                   "Content-Type": "application/json", "Cache-Control": "no-store"}
        try:
            response = self.session.request(method, self.config["dispatch_url"] + path,
                                            data=body if body else None, headers=headers,
                                            timeout=self.timeout_seconds)
        except requests.RequestException as exc:
            raise ColabEnterpriseDispatchError("COLAB_DISPATCH_NETWORK_ERROR", retryable=True) from exc
        if response.status_code in {408, 425, 429} or response.status_code >= 500:
            raise ColabEnterpriseDispatchError("COLAB_DISPATCH_TEMPORARY_FAILURE", retryable=True)
        if response.status_code >= 400:
            # Do not expose Cloud Run response text or environment values in job metadata.
            try:
                code = str(response.json().get("error", "COLAB_DISPATCH_REJECTED"))[:64]
            except Exception:
                code = "COLAB_DISPATCH_REJECTED"
            raise ColabEnterpriseDispatchError(code, retryable=False)
        try:
            result = response.json()
        except Exception as exc:
            raise ColabEnterpriseDispatchError("COLAB_DISPATCH_INVALID_RESPONSE", retryable=True) from exc
        if not isinstance(result, dict):
            raise ColabEnterpriseDispatchError("COLAB_DISPATCH_INVALID_RESPONSE", retryable=True)
        return result

    def dispatch(self, *, job_id: str, execution_id: str, profile: str,
                 repository_url: str, repository_commit: str) -> dict[str, Any]:
        if not EXECUTION_ID_RE.fullmatch(execution_id) or not execution_id.startswith(
            "vr-" + job_id.replace("-", "").lower() + "-"
        ):
            raise ColabEnterpriseDispatchError("COLAB_EXECUTION_ID_INVALID", retryable=False)
        body = json.dumps({"job_id": job_id, "execution_id": execution_id, "profile": profile,
                           "repository_url": repository_url, "repository_commit": repository_commit},
                          separators=(",", ":"), sort_keys=True).encode("utf-8")
        return self._request("POST", "/dispatch", body)

    def status(self, *, execution_id: str, operation_name: str | None) -> dict[str, Any]:
        if not EXECUTION_ID_RE.fullmatch(execution_id):
            raise ColabEnterpriseDispatchError("COLAB_EXECUTION_ID_INVALID", retryable=False)
        path = f"/status/{execution_id}"
        if operation_name:
            # Google operation names are validated again by the dispatcher.
            path += "?" + urlencode({"operation_name": operation_name})
        return self._request("GET", path)


def new_execution_id(job_id: str, attempt: int) -> str:
    from uuid import UUID

    if attempt < 1:
        raise ValueError("Colab execution attempt must be positive")
    return f"vr-{UUID(str(job_id)).hex}-{attempt}"
