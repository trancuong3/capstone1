from __future__ import annotations

import base64
import json
import unittest
from unittest.mock import Mock

from service import (
    DispatcherError,
    VertexNotebookClient,
    build_create_request,
    canonical_request,
    make_notebook,
    notebook_execution_resource,
    verify_signature,
)


JOB_ID = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
EXECUTION_ID = "vr-a5fd82cb490a4e59bad364e8a6f88d70-1"
CONFIG = {
    "GCP_PROJECT_ID": "training-project",
    "GCP_REGION": "us-central1",
    "COLAB_RUNTIME_TEMPLATE_RESOURCE": "projects/training-project/locations/us-central1/notebookRuntimeTemplates/viread-gpu",
    "COLAB_OUTPUT_GCS_URI": "gs://viread-training-results",
    "COLAB_RUNTIME_SERVICE_ACCOUNT": "viread-colab@training-project.iam.gserviceaccount.com",
    "VIREAD_REPOSITORY_URL": "https://github.com/trancuong3/capstone1.git",
    "VIREAD_REPOSITORY_COMMIT": "a" * 40,
    "VIREAD_API_BASE_SECRET_RESOURCE": "projects/training-project/secrets/viread-api-base/versions/latest",
    "VIREAD_WORKER_TOKEN_SECRET_RESOURCE": "projects/training-project/secrets/viread-worker-token/versions/latest",
}


class DispatcherServiceTests(unittest.TestCase):
    def test_hmac_authentication_binds_timestamp_method_path_and_body(self):
        import hashlib
        import hmac

        secret, timestamp, method, path, body = "x" * 48, "1000", "POST", "/dispatch", b'{"job":1}'
        signature = hmac.new(secret.encode(), canonical_request(timestamp, method, path, body), hashlib.sha256).hexdigest()
        self.assertTrue(verify_signature(secret, timestamp, method, path, body, signature, now=1000))
        self.assertFalse(verify_signature(secret, timestamp, "GET", path, body, signature, now=1000))
        self.assertFalse(verify_signature(secret, "1", method, path, body, signature, now=1000))

    def test_execution_request_uses_pinned_job_profile_gpu_template_and_runtime_identity(self):
        resource, body = build_create_request(JOB_ID, EXECUTION_ID, "FLOW2_ADMIN_VERIFIED", CONFIG)
        self.assertEqual(resource, "projects/training-project/locations/us-central1/notebookExecutionJobs/" + EXECUTION_ID)
        self.assertEqual(body["serviceAccount"], CONFIG["COLAB_RUNTIME_SERVICE_ACCOUNT"])
        self.assertEqual(body["notebookRuntimeTemplateResourceName"], CONFIG["COLAB_RUNTIME_TEMPLATE_RESOURCE"])
        notebook = json.loads(base64.b64decode(body["directNotebookSource"]["content"]))
        cell = "".join(notebook["cells"][0]["source"])
        compile(cell, "generated-viread-colab-enterprise-cell", "exec")
        self.assertIn(JOB_ID, cell)
        self.assertIn(CONFIG["VIREAD_REPOSITORY_COMMIT"], cell)
        self.assertIn("google-cloud-storage==3.17.1", cell)
        self.assertIn("GCSJobStateStore", cell)
        self.assertIn("locked_test_manifest_sha256", cell)
        self.assertIn("worker.run_job_once(JOB_ID, expected_profile=EXPECTED_PROFILE)", cell)
        self.assertNotIn("worker_token = \"", cell)

    def test_notebook_contract_rejects_unpinned_revision_and_unknown_profile(self):
        with self.assertRaisesRegex(DispatcherError, "REPOSITORY_COMMIT_MUST_BE_PINNED"):
            make_notebook(JOB_ID, "FLOW2_ADMIN_VERIFIED", CONFIG["VIREAD_REPOSITORY_URL"],
                          "main", CONFIG["VIREAD_API_BASE_SECRET_RESOURCE"],
                          CONFIG["VIREAD_WORKER_TOKEN_SECRET_RESOURCE"], CONFIG["COLAB_OUTPUT_GCS_URI"])
        with self.assertRaisesRegex(DispatcherError, "UNSUPPORTED_TRAINING_PROFILE"):
            make_notebook(JOB_ID, "ORIGINAL", CONFIG["VIREAD_REPOSITORY_URL"], "a" * 40,
                          CONFIG["VIREAD_API_BASE_SECRET_RESOURCE"],
                          CONFIG["VIREAD_WORKER_TOKEN_SECRET_RESOURCE"], CONFIG["COLAB_OUTPUT_GCS_URI"])

    def test_job_id_is_idempotency_key_for_enterprise_create(self):
        class Response:
            status_code = 200

            def json(self):
                return {"name": "projects/training-project/locations/us-central1/operations/op-1"}

        session = Mock()
        session.post.return_value = Response()
        client = VertexNotebookClient("training-project", "us-central1", session=session)
        result = client.create(JOB_ID, EXECUTION_ID, "FLOW1_EXTERNAL_TRDG", CONFIG)
        self.assertEqual(result["resource_name"], notebook_execution_resource("training-project", "us-central1", EXECUTION_ID))
        self.assertEqual(session.post.call_args.kwargs["params"], {"notebookExecutionJobId": EXECUTION_ID})


if __name__ == "__main__":
    unittest.main()
