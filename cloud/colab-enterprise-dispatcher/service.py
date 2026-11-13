from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any
from urllib.parse import quote

EXECUTION_ID_RE = re.compile(r"^vr-[a-f0-9]{32}-[1-9][0-9]*$")
SHA_RE = re.compile(r"^[a-f0-9]{40}$")
SECRET_RESOURCE_RE = re.compile(r"^projects/[a-zA-Z0-9-]+/secrets/[a-zA-Z0-9_-]+/versions/(?:latest|[1-9][0-9]*)$")
PROFILES = {"FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED"}


class DispatcherError(RuntimeError):
    def __init__(self, code: str, status_code: int = 500):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def canonical_request(timestamp: str, method: str, path: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return f"{timestamp}\n{method.upper()}\n{path}\n{body_hash}".encode("utf-8")


def verify_signature(secret: str, timestamp: str, method: str, path: str,
                     body: bytes, signature: str, *, now: int | None = None) -> bool:
    if len(secret) < 32 or not timestamp.isdigit() or len(timestamp) > 12:
        return False
    current = int(time.time()) if now is None else now
    if abs(current - int(timestamp)) > 300:
        return False
    expected = hmac.new(secret.encode("utf-8"), canonical_request(
        timestamp, method, path, body), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def _required(env: dict[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise DispatcherError(f"CONFIG_MISSING_{key}", 503)
    return value


def make_notebook(job_id: str, profile: str, repository_url: str, repository_commit: str,
                  api_secret_resource: str, worker_token_secret_resource: str,
                  state_gcs_uri: str) -> bytes:
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", job_id):
        raise DispatcherError("INVALID_TRAINING_JOB_ID", 422)
    if profile not in PROFILES:
        raise DispatcherError("UNSUPPORTED_TRAINING_PROFILE", 422)
    if not SHA_RE.fullmatch(repository_commit.lower()):
        raise DispatcherError("REPOSITORY_COMMIT_MUST_BE_PINNED", 422)
    if not repository_url.startswith("https://github.com/") or repository_url.endswith(".git/"):
        raise DispatcherError("REPOSITORY_URL_MUST_BE_HTTPS_GITHUB", 422)
    if not SECRET_RESOURCE_RE.fullmatch(api_secret_resource):
        raise DispatcherError("INVALID_API_SECRET_RESOURCE", 422)
    if not SECRET_RESOURCE_RE.fullmatch(worker_token_secret_resource):
        raise DispatcherError("INVALID_WORKER_TOKEN_SECRET_RESOURCE", 422)
    if not re.fullmatch(r"gs://[a-z0-9][a-z0-9._-]*(?:/[^\s?#]*)?", state_gcs_uri):
        raise DispatcherError("INVALID_RESUME_STATE_GCS_URI", 422)

    cell = f'''import os, subprocess, sys, shutil, json
from pathlib import Path

JOB_ID = {json.dumps(job_id)}
EXPECTED_PROFILE = {json.dumps(profile)}
REPOSITORY_URL = {json.dumps(repository_url)}
REPOSITORY_COMMIT = {json.dumps(repository_commit.lower())}
API_BASE_SECRET = {json.dumps(api_secret_resource)}
WORKER_TOKEN_SECRET = {json.dumps(worker_token_secret_resource)}
STATE_GCS_URI = {json.dumps(state_gcs_uri.rstrip('/'))}
REPO = Path("/content/viread-colab-worker")

if REPO.exists():
    shutil.rmtree(REPO)
subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", REPOSITORY_URL, str(REPO)], check=True)
subprocess.run(["git", "-C", str(REPO), "fetch", "--depth=1", "origin", REPOSITORY_COMMIT], check=True)
subprocess.run(["git", "-C", str(REPO), "checkout", "--detach", REPOSITORY_COMMIT], check=True)
actual_commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
if actual_commit != REPOSITORY_COMMIT:
    raise RuntimeError("WORKER_REPOSITORY_COMMIT_MISMATCH")

subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-r", str(REPO / "ai/vietocr_v2/requirements.txt")], check=True)
subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "google-cloud-secret-manager==2.24.0", "google-cloud-storage==3.17.1"], check=True)
sys.path.insert(0, str(REPO))
os.chdir(REPO)

from google.cloud import secretmanager
secret_client = secretmanager.SecretManagerServiceClient()
def secret_value(resource_name):
    return secret_client.access_secret_version(request={{"name": resource_name}}).payload.data.decode("utf-8")

api_base = secret_value(API_BASE_SECRET).strip().rstrip("/")
worker_token = secret_value(WORKER_TOKEN_SECRET).strip()
if not api_base.startswith("https://") or len(worker_token) < 32:
    raise RuntimeError("COLAB_RUNTIME_SECRET_CONFIGURATION_INVALID")

from ai.vietocr_v2.colab_worker import ColabWorker
from ai.vietocr_v2.colab_state_store import GCSJobStateStore
def state_store_factory(job, run_dir):
    identity = {{
        "training_job_id": str(job["id"]),
        "profile": str(job["profile"]),
        "dataset_manifest_sha256": str(job["manifest_sha256"]),
        "parent_checkpoint_sha256": str(job["parent_checkpoint_sha256"]),
        "config_sha256": str(job["config_sha256"]),
        "repository_commit": REPOSITORY_COMMIT,
        "locked_test_manifest_sha256": str(job.get("locked_test_manifest_sha256") or "unregistered"),
        "locked_test_version_id": str(job.get("locked_test_version_id") or "unregistered"),
    }}
    state_uri = STATE_GCS_URI + "/jobs/" + str(job["id"])
    return GCSJobStateStore(state_uri, identity, run_dir)

worker = ColabWorker(api_base, worker_token, Path("/content/viread-training") / JOB_ID,
                     poll_seconds=5, state_store_factory=state_store_factory)
try:
    processed = worker.run_job_once(JOB_ID, expected_profile=EXPECTED_PROFILE)
    if not processed:
        raise RuntimeError("REQUESTED_TRAINING_JOB_NOT_CLAIMED")
    print("ViRead training job completed; inspect the Admin lifecycle page for checkpoint and benchmark status.")
finally:
    worker.session.close()
'''
    notebook = {
        "cells": [{
            "cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": [line + "\n" for line in cell.splitlines()],
        }],
        "metadata": {
            "colab": {"name": "viread_enterprise_job.ipynb", "provenance": []},
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    return json.dumps(notebook, sort_keys=True, separators=(",", ":")).encode("utf-8")


def notebook_execution_resource(project: str, region: str, execution_id: str) -> str:
    if not EXECUTION_ID_RE.fullmatch(execution_id):
        raise DispatcherError("INVALID_EXECUTION_ID", 422)
    return f"projects/{project}/locations/{region}/notebookExecutionJobs/{execution_id}"


def build_create_request(job_id: str, execution_id: str, profile: str,
                         config: dict[str, str]) -> tuple[str, dict[str, Any]]:
    project = _required(config, "GCP_PROJECT_ID")
    region = _required(config, "GCP_REGION")
    runtime_template = _required(config, "COLAB_RUNTIME_TEMPLATE_RESOURCE")
    output_uri = _required(config, "COLAB_OUTPUT_GCS_URI")
    runtime_service_account = _required(config, "COLAB_RUNTIME_SERVICE_ACCOUNT")
    repository_url = _required(config, "VIREAD_REPOSITORY_URL")
    repository_commit = _required(config, "VIREAD_REPOSITORY_COMMIT")
    api_secret_resource = _required(config, "VIREAD_API_BASE_SECRET_RESOURCE")
    token_secret_resource = _required(config, "VIREAD_WORKER_TOKEN_SECRET_RESOURCE")
    timeout = int(config.get("COLAB_EXECUTION_TIMEOUT_SECONDS", "21600"))
    if not 600 <= timeout <= 43200:
        raise DispatcherError("COLAB_EXECUTION_TIMEOUT_OUT_OF_RANGE", 422)
    if not output_uri.startswith("gs://"):
        raise DispatcherError("COLAB_OUTPUT_URI_MUST_BE_GCS", 422)
    expected_template_prefix = f"projects/{project}/locations/{region}/notebookRuntimeTemplates/"
    if not runtime_template.startswith(expected_template_prefix):
        raise DispatcherError("COLAB_RUNTIME_TEMPLATE_REGION_MISMATCH", 422)
    if not runtime_service_account.endswith(".iam.gserviceaccount.com"):
        raise DispatcherError("INVALID_COLAB_RUNTIME_SERVICE_ACCOUNT", 422)
    notebook = make_notebook(job_id, profile, repository_url, repository_commit,
                             api_secret_resource, token_secret_resource,
                             f"{output_uri.rstrip('/')}/viread-resume")
    resource_name = notebook_execution_resource(project, region, execution_id)
    body = {
        "displayName": f"ViRead {profile} {execution_id[-8:]}",
        "executionTimeout": f"{timeout}s",
        "directNotebookSource": {"content": base64.b64encode(notebook).decode("ascii")},
        "notebookRuntimeTemplateResourceName": runtime_template,
        "gcsOutputUri": f"{output_uri.rstrip('/')}/viread-executions/{execution_id}",
        "serviceAccount": runtime_service_account,
        "labels": {"application": "viread", "training_profile": profile.lower(),
                   "training_job": job_id.replace("-", "")[:32]},
    }
    return resource_name, body


class VertexNotebookClient:
    def __init__(self, project: str, region: str, *, session: Any | None = None):
        self.project = project
        self.region = region
        if session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession

            credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            session = AuthorizedSession(credentials)
        self.session = session
        self.api = f"https://{region}-aiplatform.googleapis.com/v1"
        self.parent = f"projects/{project}/locations/{region}"

    def create(self, job_id: str, execution_id: str, profile: str,
               config: dict[str, str]) -> dict[str, Any]:
        resource_name, body = build_create_request(job_id, execution_id, profile, config)
        url = f"{self.api}/{self.parent}/notebookExecutionJobs"
        response = self.session.post(url, params={"notebookExecutionJobId": execution_id},
                                     json=body, timeout=30)
        if response.status_code == 409:
            existing = self.get_resource(resource_name)
            return {"resource_name": resource_name,
                    "operation_name": existing.get("operation_name"),
                    "job_state": existing.get("job_state", "JOB_STATE_PENDING"),
                    "idempotent": True}
        if response.status_code >= 400:
            raise DispatcherError("GOOGLE_NOTEBOOK_EXECUTION_CREATE_FAILED", 502)
        operation_name = response.json().get("name")
        return {"resource_name": resource_name, "operation_name": operation_name,
                "job_state": "JOB_STATE_PENDING", "idempotent": False}

    def get_resource(self, resource_name: str, operation_name: str | None = None) -> dict[str, Any]:
        quoted = quote(resource_name, safe="/")
        response = self.session.get(f"{self.api}/{quoted}", timeout=20)
        if response.status_code == 404:
            if operation_name:
                operation = self.session.get(f"{self.api}/{quote(operation_name, safe='/')}", timeout=20)
                if operation.status_code == 200:
                    result = operation.json()
                    if not result.get("done"):
                        return {"job_state": "JOB_STATE_PENDING", "operation_name": operation_name}
                    response = self.session.get(f"{self.api}/{quoted}", timeout=20)
                    if response.status_code == 404:
                        error = result.get("error") or {}
                        if error:
                            return {"job_state": "JOB_STATE_FAILED", "error_code": str(error.get("code", "GOOGLE_OPERATION_FAILED"))[:64]}
            if response.status_code == 404:
                return {"job_state": "JOB_STATE_PENDING", "operation_name": operation_name}
        if response.status_code >= 400:
            raise DispatcherError("GOOGLE_NOTEBOOK_EXECUTION_STATUS_UNAVAILABLE", 502)
        result = response.json()
        status = result.get("status") or {}
        return {"job_state": result.get("jobState", "JOB_STATE_PENDING"),
                "resource_name": result.get("name", resource_name),
                "operation_name": operation_name,
                "error_code": str(status.get("code", ""))[:64] or None,
                "update_time": result.get("updateTime")}


def config_from_env() -> dict[str, str]:
    keys = (
        "GCP_PROJECT_ID", "GCP_REGION", "COLAB_RUNTIME_TEMPLATE_RESOURCE",
        "COLAB_OUTPUT_GCS_URI", "COLAB_RUNTIME_SERVICE_ACCOUNT",
        "VIREAD_REPOSITORY_URL", "VIREAD_REPOSITORY_COMMIT",
        "VIREAD_API_BASE_SECRET_RESOURCE", "VIREAD_WORKER_TOKEN_SECRET_RESOURCE",
        "COLAB_EXECUTION_TIMEOUT_SECONDS",
    )
    return {key: os.environ[key] for key in keys if key in os.environ}
