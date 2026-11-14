import io
import base64
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "WORK/modules/video"))
import tts_api


class SpeechEndpointTest(unittest.TestCase):
    def test_mimo_request_decode_cache_and_invalid_response(self):
        with TemporaryDirectory() as tmp, patch.dict("os.environ", {
            "VIDEO_TTS_ENDPOINT": "https://test.invalid/v1/chat/completions",
            "VIDEO_TTS_MODEL": "mimo-v2.5-tts", "VIDEO_TTS_KEY": "test-key",
            "VIDEO_TTS_PROTOCOL": "mimo"
        }), patch.object(tts_api, "urlopen") as send, patch.object(tts_api.subprocess, "run") as probe:
            encoded = base64.b64encode(b"test audio").decode()
            send.side_effect = lambda *a, **k: io.BytesIO(json.dumps({"choices": [{"message": {"audio": {"data": encoded}}}]}).encode())
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            segments = [{"id": "S1", "narration": "第一段。"}]
            def render():
                return tts_api.synth_all(segments, Path(tmp), "api:茉莉", "+0%", "ffprobe")
            self.assertEqual(render()[1], ["S1"])
            req = send.call_args.args[0]
            self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
            self.assertEqual(json.loads(req.data), {"model": "mimo-v2.5-tts", "messages": [{"role": "assistant", "content": "第一段。"}], "audio": {"format": "mp3", "voice": "茉莉"}, "stream": False})
            self.assertEqual((Path(tmp) / "S1.mp3").read_bytes(), b"test audio")
            self.assertEqual(render()[1], [])
            segments[0]["narration"] = "改稿。"
            encoded = "invalid!"
            with self.assertRaisesRegex(ValueError, "MiMo"):
                render()
            self.assertEqual((Path(tmp) / "S1.mp3").read_bytes(), b"test audio")

    def test_request_cache_and_bad_audio(self):
        with TemporaryDirectory() as tmp, patch.dict("os.environ", {
            "VIDEO_TTS_ENDPOINT": "https://test.invalid/v1/audio/speech",
            "VIDEO_TTS_MODEL": "demo", "VIDEO_TTS_KEY": "test-key"
        }), patch.object(tts_api, "urlopen") as send, patch.object(tts_api.subprocess, "run") as probe:
            send.side_effect = lambda *a, **k: io.BytesIO(b"test audio")
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            segments = [{"id": "S1", "narration": "第一段。"}]
            def render():
                return tts_api.synth_all(segments, Path(tmp), "api:test", "+0%", "ffprobe")

            result, fresh = render()
            self.assertEqual(fresh, ["S1"])
            self.assertEqual(result[0]["duration"], 2.5)
            req = send.call_args.args[0]
            self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
            self.assertEqual(json.loads(req.data)["input"], segments[0]["narration"])
            self.assertEqual(render()[1], [])
            segments[0]["narration"] = "改稿。"
            probe.return_value.stdout = '{"streams":[]}'
            with self.assertRaisesRegex(ValueError, "S1"):
                render()
            self.assertEqual(json.loads((Path(tmp) / "S1.json").read_text())["narration"], "第一段。")
            self.assertEqual(send.call_count, 2)
