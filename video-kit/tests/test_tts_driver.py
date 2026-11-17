import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "WORK/modules/video"))
import tts_api
import tts_driver


class DriverRateTest(unittest.TestCase):
    def test_api_and_say_report_effective_rate_and_keep_warning(self):
        def run(command, **kwargs):
            if command[0] == "say":
                Path(command[command.index("-o") + 1]).write_bytes(b"aiff")
            elif command[0] == "ffmpeg":
                Path(command[-1]).write_bytes(b"mp3")
            else:
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps({
                    "streams": [{"codec_name": "mp3"}], "format": {"duration": "2.5"}
                }))

        for voice, backend in [("api:test", "speech-api"), ("say:Tingting", "say")]:
            with self.subTest(voice=voice), TemporaryDirectory() as tmp:
                root = Path(tmp)
                blueprint, output = root / "blueprint.json", root / "tts.json"
                blueprint.write_text(json.dumps({
                    "blueprint_id": "test", "segments": [{"id": "S1", "narration": "旁白"}]
                }), encoding="utf-8")
                args = ["tts_driver.py", str(blueprint), str(root / "audio"),
                        voice, "+7%", "ffprobe", str(output)]
                with patch.object(sys, "argv", args), patch.dict(os.environ, {
                    "VIDEO_TTS_ENDPOINT": "https://test.invalid/a",
                    "VIDEO_TTS_MODEL": "test", "VIDEO_TTS_PROTOCOL": "speech",
                    "VIDEO_FFMPEG": "ffmpeg"
                }), patch.object(tts_api, "urlopen", side_effect=lambda *a, **k: io.BytesIO(b"audio")), \
                        patch("subprocess.run", side_effect=run), patch("sys.stdout", new_callable=io.StringIO):
                    with self.assertWarnsRegex(UserWarning, r"不支持语速 \+7%"):
                        self.assertEqual(tts_driver.main(), 0)
                payload = json.loads(output.read_text(encoding="utf-8"))
                self.assertEqual(payload["backend"], backend)
                self.assertEqual(payload["rate"], "+0%")
                self.assertEqual(payload["segments"][0]["rate"], "+0%")


if __name__ == "__main__":
    unittest.main()
