from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.services.viread_colab_enterprise import (
    ColabEnterpriseConfigurationError,
    ColabEnterpriseDispatcher,
    enterprise_configuration,
    new_execution_id,
)


class ColabEnterpriseDispatchTests(unittest.TestCase):
    def test_enterprise_mode_blocks_without_required_endpoint_secret_or_commit(self):
        with self.assertRaisesRegex(ColabEnterpriseConfigurationError, "DISPATCH_URL"):
            enterprise_configuration({"VIREAD_COLAB_EXECUTION_MODE": "enterprise"})

    def test_manual_mode_remains_available_without_google_cloud_configuration(self):
        self.assertEqual(enterprise_configuration({"VIREAD_COLAB_EXECUTION_MODE": "manual"}), {"mode": "manual"})

    def test_execution_id_is_stable_for_job_and_attempt(self):
        job_id = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
        self.assertEqual(new_execution_id(job_id, 1), "vr-a5fd82cb490a4e59bad364e8a6f88d70-1")
        self.assertNotEqual(new_execution_id(job_id, 1), new_execution_id(job_id, 2))

    def test_dispatch_signs_exact_job_profile_and_repository_lock(self):
        config = {
            "mode": "enterprise", "dispatch_url": "https://dispatcher.example",
            "shared_secret": "x" * 48, "repository_url": "https://github.com/trancuong3/capstone1.git",
            "repository_commit": "a" * 40,
        }
        session = Mock()
        session.request.return_value = SimpleNamespace(status_code=202, json=lambda: {
            "accepted": True, "resource_name": "projects/p/locations/r/notebookExecutionJobs/abc",
        })
        client = ColabEnterpriseDispatcher(config, session=session)
        response = client.dispatch(
            job_id="a5fd82cb-490a-4e59-bad3-64e8a6f88d70",
            execution_id="vr-a5fd82cb490a4e59bad364e8a6f88d70-1",
            profile="FLOW2_ADMIN_VERIFIED", repository_url=config["repository_url"],
            repository_commit=config["repository_commit"],
        )
        self.assertTrue(response["accepted"])
        args = session.request.call_args
        self.assertEqual(args.args[:2], ("POST", "https://dispatcher.example/dispatch"))
        self.assertEqual(json.loads(args.kwargs["data"])["profile"], "FLOW2_ADMIN_VERIFIED")
        self.assertIn("X-ViRead-Signature", args.kwargs["headers"])
        self.assertNotIn(config["shared_secret"], args.kwargs["headers"]["X-ViRead-Signature"])


if __name__ == "__main__":
    unittest.main()
