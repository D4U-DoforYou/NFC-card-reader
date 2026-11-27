import unittest

from rf_platform.core.jobs import JobEvent, JobState, JobTracker


class JobTrackerTests(unittest.TestCase):
    def test_accept_progress_and_complete(self):
        tracker = JobTracker()
        tracker.update(JobEvent(12, JobState.ACCEPTED))
        tracker.update(JobEvent(12, JobState.RUNNING, "upload", 1, 3))
        tracker.update(JobEvent(12, JobState.RUNNING, "upload", 3, 3))
        tracker.update(JobEvent(12, JobState.COMPLETED, result=b"ok"))

        self.assertEqual(tracker.get(12).result, b"ok")

    def test_reject_out_of_order_first_event(self):
        with self.assertRaisesRegex(ValueError, "first event"):
            JobTracker().update(JobEvent(1, JobState.RUNNING, "read"))

    def test_reject_progress_regression(self):
        tracker = JobTracker()
        tracker.update(JobEvent(2, JobState.ACCEPTED))
        tracker.update(JobEvent(2, JobState.RUNNING, "read", 2, 4))

        with self.assertRaisesRegex(ValueError, "cannot go backwards"):
            tracker.update(JobEvent(2, JobState.RUNNING, "read", 1, 4))

    def test_terminal_job_cannot_change_state(self):
        tracker = JobTracker()
        tracker.update(JobEvent(3, JobState.ACCEPTED))
        tracker.update(JobEvent(3, JobState.CANCELLED))

        with self.assertRaisesRegex(ValueError, "invalid job transition"):
            tracker.update(JobEvent(3, JobState.COMPLETED))


if __name__ == "__main__":
    unittest.main()
