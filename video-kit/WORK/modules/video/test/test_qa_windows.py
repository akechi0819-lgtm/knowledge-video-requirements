import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace


spec = importlib.util.spec_from_file_location("qa_windows", Path(__file__).parents[1] / "qa_windows.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class FreezeDetectionTest(unittest.TestCase):
    @patch.object(qa.subprocess, "run")
    def test_cutoff_closes_open_freeze_without_probing_full_duration(self, run):
        run.return_value = SimpleNamespace(stderr="freeze_start: 8.0\n", stdout="")
        self.assertEqual(qa.detect_freezes("film.mp4", "ffmpeg", "ffprobe", 12.0), [(8.0, 4.0)])
        args = run.call_args.args[0]
        self.assertLess(args.index("-t"), args.index("-i"))
        self.assertEqual(args[args.index("-t") + 1], "12.0")
        self.assertEqual(run.call_count, 1)

    @patch.object(qa.subprocess, "run")
    def test_without_cutoff_uses_full_duration(self, run):
        run.side_effect = [SimpleNamespace(stderr="freeze_start: 8.0\n"), SimpleNamespace(stdout="20.0")]
        self.assertEqual(qa.detect_freezes("film.mp4", "ffmpeg", "ffprobe"), [(8.0, 12.0)])
        self.assertNotIn("-t", run.call_args_list[0].args[0])


if __name__ == "__main__":
    unittest.main()
