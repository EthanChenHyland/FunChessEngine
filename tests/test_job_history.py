"""Durable background work survives restarts without restarting engines."""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gui.jobs import JobRegistry, check_cancelled, progress


class JobHistoryTests(unittest.TestCase):
    def wait_finished(self, jobs: JobRegistry, identifier: str) -> dict:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            row = jobs.get(identifier)
            if row["status"] != "running":
                return row
            time.sleep(0.01)
        self.fail("Job did not finish")

    def test_completed_result_survives_restart_and_dismissal_is_durable(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            jobs = JobRegistry()
            jobs.enable_history(Path(folder))
            row = jobs.submit("regression", lambda: {"rows": [{"correct": True}]})
            completed = self.wait_finished(jobs, row["id"])
            self.assertGreaterEqual(completed["finished_at"], completed["started_at"])
            restarted = JobRegistry()
            restarted.enable_history(Path(folder))
            self.assertEqual(restarted.get(row["id"])["result"], completed["result"])
            self.assertTrue(restarted.list()[0]["has_result"])
            self.assertNotIn("result", restarted.list()[0])
            restarted.dismiss(row["id"])
            again = JobRegistry()
            again.enable_history(Path(folder))
            self.assertEqual(again.list(), [])

    def test_restart_marks_running_job_interrupted_and_preserves_partial(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            jobs = JobRegistry()
            jobs.enable_history(Path(folder))
            started = threading.Event()
            stop = threading.Event()

            def work() -> dict:
                progress({"completed": 2, "total": 4, "partial": {"games": [1, 2]}})
                started.set()
                stop.wait(3)
                return {}

            row = jobs.submit("tournament", work)
            try:
                self.assertTrue(started.wait(2))
                with self.assertRaisesRegex(ValueError, "Cancel"):
                    jobs.dismiss(row["id"])
                # Force a progress checkpoint as though one second has elapsed.
                jobs.last_saved[row["id"]] = 0
                jobs._update(row["id"], progress=jobs.get(row["id"])["progress"])
                restarted = JobRegistry()
                restarted.enable_history(Path(folder))
                recovered = restarted.get(row["id"])
                self.assertEqual(recovered["status"], "interrupted")
                self.assertEqual(recovered["progress"]["partial"]["games"], [1, 2])
                self.assertTrue(restarted.list()[0]["has_partial"])
                self.assertNotIn("partial", restarted.list()[0]["progress"])
                self.assertEqual(restarted.cancels, {})
            finally:
                stop.set()
                self.wait_finished(jobs, row["id"])

    def test_cancelled_import_retains_latest_progress(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            jobs = JobRegistry()
            jobs.enable_history(Path(folder))
            started = threading.Event()

            def work() -> dict:
                progress({"partial": {"imported": 100}, "completed": 100})
                started.set()
                while True:
                    check_cancelled()
                    time.sleep(0.01)

            row = jobs.submit("reference-import", work)
            self.assertTrue(started.wait(2))
            jobs.cancel(row["id"])
            self.assertEqual(self.wait_finished(jobs, row["id"])["status"], "cancelled")
            restarted = JobRegistry()
            restarted.enable_history(Path(folder))
            self.assertEqual(restarted.get(row["id"])["progress"]["partial"], {"imported": 100})

    def test_retention_is_bounded_and_corrupt_file_is_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            jobs = JobRegistry()
            jobs.enable_history(Path(folder))
            identifiers = []
            for index in range(15):
                row = jobs.submit("test", lambda index=index: {"index": index})
                identifiers.append(row["id"])
                self.wait_finished(jobs, row["id"])
            self.assertEqual(len(list(Path(folder).glob("*.json"))), 12)
            (Path(folder) / f"{identifiers[-1]}.json").write_text("broken json")
            restarted = JobRegistry()
            restarted.enable_history(Path(folder))
            self.assertEqual(len(restarted.list()), 11)
            self.assertNotIn(identifiers[0], restarted.jobs)
            self.assertEqual(restarted.get(identifiers[-2])["result"], {"index": 13})

    def test_oversized_results_remain_live_but_restart_retains_only_summary(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            jobs = JobRegistry()
            jobs.enable_history(Path(folder))
            row = jobs.submit("selfplay", lambda: {"data": "x" * (17 * 1024 * 1024)})
            completed = self.wait_finished(jobs, row["id"])
            self.assertIn("result", completed)
            self.assertIn("16 MB", completed["history_note"])
            restarted = JobRegistry()
            restarted.enable_history(Path(folder))
            self.assertFalse(restarted.list()[0]["has_result"])
            self.assertLess((Path(folder) / f"{row['id']}.json").stat().st_size, 1000)

    def test_failed_write_does_not_lose_live_result_or_previous_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            jobs = JobRegistry()
            jobs.enable_history(Path(folder))
            row = jobs.submit("test", lambda: {"value": 1})
            self.wait_finished(jobs, row["id"])
            with patch("gui.jobs.os.fsync", side_effect=OSError("Disk full")):
                jobs._update(row["id"], result={"value": 2}, status="completed")
            self.assertEqual(jobs.get(row["id"])["result"], {"value": 2})
            self.assertIn("Disk full", jobs.get(row["id"])["persistence_error"])
            self.assertEqual(list(Path(folder).glob("*.tmp")), [])
            saved = json.loads((Path(folder) / f"{row['id']}.json").read_text())
            self.assertEqual(saved["result"], {"value": 1})
