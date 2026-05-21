import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as app_module


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.previous_api_key = app_module.settings.api_key
        app_module.settings.api_key = ""
        app_module.ingestion_jobs.clear()
        self.client = TestClient(app_module.app)

    def tearDown(self):
        app_module.settings.api_key = self.previous_api_key
        app_module.ingestion_jobs.clear()

    def test_api_key_is_enforced_when_configured(self):
        app_module.settings.api_key = "test-secret"

        missing_key = self.client.get("/api/ingest/status/missing")
        self.assertEqual(missing_key.status_code, 401)

        with_key = self.client.get(
            "/api/ingest/status/missing",
            headers={"X-API-Key": "test-secret"},
        )
        self.assertEqual(with_key.status_code, 404)

    def test_drive_link_splitter_supports_arrays_commas_and_newlines(self):
        links = app_module._split_drive_links(
            ["https://drive.google.com/a, https://drive.google.com/b\nhttps://drive.google.com/c"],
            "https://drive.google.com/d",
        )

        self.assertEqual(
            links,
            [
                "https://drive.google.com/a",
                "https://drive.google.com/b",
                "https://drive.google.com/c",
                "https://drive.google.com/d",
            ],
        )

    def test_drive_ingestion_creates_status_job_for_multiple_links(self):
        calls = []

        def fake_ingest(drive_link, vector_store, session_id="default"):
            calls.append((drive_link, session_id))
            return True

        with patch.object(app_module, "process_and_ingest_drive_folder", fake_ingest):
            response = self.client.post(
                "/api/ingest/drive",
                json={
                    "drive_links": ["link-a", "link-b"],
                    "session_id": "session-one",
                    "clear_previous": False,
                },
            )

        self.assertEqual(response.status_code, 200)
        job_id = response.json()["job_id"]
        self.assertEqual(calls, [("link-a", "session-one"), ("link-b", "session-one")])

        status = self.client.get(f"/api/ingest/status/{job_id}")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()["status"], "completed")
        self.assertEqual(status.json()["completed"], ["link-a", "link-b"])


if __name__ == "__main__":
    unittest.main()
