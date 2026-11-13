from __future__ import annotations

import json
import os
import re

import functions_framework

from service import DispatcherError, VertexNotebookClient, config_from_env, verify_signature

EXECUTION_ID_RE = re.compile(r"^vr-[a-f0-9]{32}-[1-9][0-9]*$")
OPERATION_RE = re.compile(r"^projects/[a-zA-Z0-9-]+/locations/[a-zA-Z0-9-]+/operations/[a-zA-Z0-9-]+$")


def _json_response(payload: dict, status: int = 200):
    return (json.dumps(payload, separators=(",", ":")), status,
            {"Content-Type": "application/json", "Cache-Control": "no-store"})


def _authorize(request) -> None:
    secret = os.getenv("VIREAD_COLAB_DISPATCH_SHARED_SECRET", "")
    timestamp = request.headers.get("X-ViRead-Timestamp", "")
    signature = request.headers.get("X-ViRead-Signature", "")
    signed_path = request.full_path.rstrip("?")
    if not verify_signature(secret, timestamp, request.method, signed_path,
                            request.get_data(cache=True), signature):
        raise DispatcherError("DISPATCH_AUTHENTICATION_FAILED", 401)


def _client(config: dict[str, str]) -> VertexNotebookClient:
    project = config.get("GCP_PROJECT_ID", "").strip()
    region = config.get("GCP_REGION", "").strip()
    if not project or not region:
        raise DispatcherError("CONFIG_MISSING_GCP_PROJECT_OR_REGION", 503)
    return VertexNotebookClient(project, region)


@functions_framework.http
def handler(request):
    try:
        _authorize(request)
        config = config_from_env()
        if request.method == "POST" and request.path == "/dispatch":
            raw = request.get_data(cache=True)
            if len(raw) > 8192:
                raise DispatcherError("DISPATCH_REQUEST_TOO_LARGE", 413)
            try:
                payload = request.get_json(silent=False)
            except Exception as exc:
                raise DispatcherError("INVALID_DISPATCH_JSON", 400) from exc
            if not isinstance(payload, dict):
                raise DispatcherError("INVALID_DISPATCH_REQUEST", 400)
            job_id = str(payload.get("job_id", ""))
            execution_id = str(payload.get("execution_id", ""))
            profile = str(payload.get("profile", ""))
            if (payload.get("repository_url") != config.get("VIREAD_REPOSITORY_URL")
                    or payload.get("repository_commit") != config.get("VIREAD_REPOSITORY_COMMIT", "").lower()):
                raise DispatcherError("WORKER_REPOSITORY_LOCK_MISMATCH", 409)
            if not EXECUTION_ID_RE.fullmatch(execution_id) or not execution_id.startswith(
                "vr-" + job_id.replace("-", "").lower() + "-"
            ):
                raise DispatcherError("EXECUTION_ID_DOES_NOT_MATCH_JOB", 422)
            result = _client(config).create(job_id, execution_id, profile, config)
            return _json_response({"accepted": True, **result}, 202)

        if request.method == "GET" and request.path.startswith("/status/"):
            execution_id = request.path.rsplit("/", 1)[-1]
            if not EXECUTION_ID_RE.fullmatch(execution_id):
                raise DispatcherError("INVALID_EXECUTION_ID", 422)
            project = config.get("GCP_PROJECT_ID", "").strip()
            region = config.get("GCP_REGION", "").strip()
            if not project or not region:
                raise DispatcherError("CONFIG_MISSING_GCP_PROJECT_OR_REGION", 503)
            resource_name = (f"projects/{project}/locations/{region}/"
                             f"notebookExecutionJobs/{execution_id}")
            operation_name = request.args.get("operation_name") or None
            if operation_name and not OPERATION_RE.fullmatch(operation_name):
                raise DispatcherError("INVALID_OPERATION_RESOURCE", 422)
            result = _client(config).get_resource(resource_name, operation_name)
            return _json_response(result)

        return _json_response({"error": "NOT_FOUND"}, 404)
    except DispatcherError as exc:
        return _json_response({"error": exc.code}, exc.status_code)
    except Exception:
        # Never include exception text, request bodies, or environment values in responses.
        return _json_response({"error": "DISPATCHER_INTERNAL_ERROR"}, 500)
