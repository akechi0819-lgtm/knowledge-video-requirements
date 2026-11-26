import io
import base64
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "WORK/modules/video"))
import tts_api


class SpeechEndpointTest(unittest.TestCase):
    def test_cloud_endpoint_rejects_private_addresses(self):
        with patch.dict("os.environ", {"BOHACK_CLOUD_MODEL": "test"}), patch.object(tts_api.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]), patch.object(tts_api, "urlopen") as send:
            with self.assertRaisesRegex(ValueError, "内网"):
                with tts_api.speech_response("https://private.test/v1/audio/speech", "custom", "voice-7", "旁白", "key", "speech"):
                    pass
            send.assert_not_called()

    def test_custom_speech_preserves_provider_voice(self):
        with patch.object(tts_api, "urlopen", return_value=io.BytesIO(b"audio")) as send:
            with tts_api.speech_response("https://speech.example/v1/audio/speech", "custom", "voice-7", "旁白", "key", "speech"):
                pass
            self.assertEqual(json.loads(send.call_args.args[0].data)["voice"], "voice-7")

    def test_changed_tts_configuration_invalidates_cache(self):
        with TemporaryDirectory() as tmp, patch.dict('os.environ', {
            'VIDEO_TTS_ENDPOINT': 'https://test.invalid/a', 'VIDEO_TTS_MODEL': 'model-a',
            'VIDEO_TTS_PROTOCOL': 'speech'
        }), patch.object(tts_api, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(b'audio')) as send, patch.object(tts_api, "run_media") as probe:
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            segments = [{'id':'S1', 'narration':'旁白'}]
            def render(voice='api:test'):
                return tts_api.synth_all(segments, Path(tmp), voice, '+0%', 'ffprobe')[1]
            self.assertEqual(render(), ['S1'])
            self.assertEqual(render(), [])
            with patch.dict('os.environ', {'VIDEO_TTS_MODEL':'model-b'}): self.assertEqual(render(), ['S1'])
            with patch.dict('os.environ', {'VIDEO_TTS_ENDPOINT':'https://test.invalid/b'}): self.assertEqual(render(), ['S1'])
            self.assertEqual(render('api:other'), ['S1'])
            self.assertEqual(send.call_count, 4)

    def test_mimo_request_decode_cache_and_invalid_response(self):
        with TemporaryDirectory() as tmp, patch.dict("os.environ", {
            "VIDEO_TTS_ENDPOINT": "https://test.invalid/v1/chat/completions",
            "VIDEO_TTS_MODEL": "mimo-v2.5-tts", "VIDEO_TTS_KEY": "test-key",
            "VIDEO_TTS_PROTOCOL": "mimo"
        }), patch.object(tts_api, "urlopen") as send, patch.object(tts_api, "run_media") as probe:
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
        }), patch.object(tts_api, "urlopen") as send, patch.object(tts_api, "run_media") as probe:
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
            self.assertEqual(json.loads((Path(tmp) / "S1.json").read_text(encoding="utf-8"))["narration"], "第一段。")
            self.assertEqual(send.call_count, 2)

    def test_rate_downgraded_at_entry_and_cache_signature(self):
        with TemporaryDirectory() as tmp, patch.dict('os.environ', {
            'VIDEO_TTS_ENDPOINT': 'https://test.invalid/a', 'VIDEO_TTS_MODEL': 'model-a',
            'VIDEO_TTS_PROTOCOL': 'speech'
        }), patch.object(tts_api, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(b'audio')) as send, patch.object(tts_api, "run_media") as probe:
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            segments = [{'id': 'S1', 'narration': '旁白'}]
            with self.assertWarnsRegex(UserWarning, r'不支持语速 \+7%'):
                result, fresh = tts_api.synth_all(segments, Path(tmp), 'api:test', '+7%', 'ffprobe')
            self.assertEqual(fresh, ['S1'])
            self.assertEqual(result[0]['rate'], '+0%')
            saved = json.loads((Path(tmp) / 'S1.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['rate'], '+0%')
            with self.assertWarnsRegex(UserWarning, r'不支持语速 \+7%'):
                _, fresh = tts_api.synth_all(segments, Path(tmp), 'api:test', '+7%', 'ffprobe')
            self.assertEqual(fresh, [])
            _, fresh = tts_api.synth_all(segments, Path(tmp), 'api:test', '+0%', 'ffprobe')
            self.assertEqual(fresh, [])
            self.assertEqual(send.call_count, 1)

    def test_urlerror_retried_then_succeeds(self):
        with TemporaryDirectory() as tmp, patch.dict('os.environ', {
            'VIDEO_TTS_ENDPOINT': 'https://test.invalid/a', 'VIDEO_TTS_MODEL': 'model-a'
        }), patch.object(tts_api, 'urlopen', side_effect=[
            URLError('connection refused'), URLError('timed out'), io.BytesIO(b'audio')]) as send, \
                patch.object(tts_api, "run_media") as probe, patch.object(tts_api.time, 'sleep') as sleep:
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            _, fresh = tts_api.synth_all([{'id': 'S1', 'narration': '旁白'}], Path(tmp), 'api:test', '+0%', 'ffprobe')
            self.assertEqual(fresh, ['S1'])
            self.assertEqual(send.call_count, 3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [2, 5])

    def test_urlerror_exhausted_raises_valueerror(self):
        with TemporaryDirectory() as tmp, patch.dict('os.environ', {
            'VIDEO_TTS_ENDPOINT': 'https://test.invalid/a', 'VIDEO_TTS_MODEL': 'model-a'
        }), patch.object(tts_api, 'urlopen', side_effect=URLError('connection refused')) as send, \
                patch.object(tts_api, "run_media") as probe, patch.object(tts_api.time, 'sleep') as sleep:
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            with self.assertRaisesRegex(ValueError, r'\[S1\] 配音服务连接失败'):
                tts_api.synth_all([{'id': 'S1', 'narration': '旁白'}], Path(tmp), 'api:test', '+0%', 'ffprobe')
            self.assertEqual(send.call_count, 3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [2, 5])
            self.assertFalse((Path(tmp) / 'S1.json').exists())

    def test_httperror_not_retried(self):
        with TemporaryDirectory() as tmp, patch.dict('os.environ', {
            'VIDEO_TTS_ENDPOINT': 'https://test.invalid/a', 'VIDEO_TTS_MODEL': 'model-a'
        }), patch.object(tts_api, 'urlopen', side_effect=HTTPError('https://test.invalid/a', 500, 'boom', {}, None)) as send, \
                patch.object(tts_api, "run_media") as probe, patch.object(tts_api.time, 'sleep') as sleep:
            probe.return_value.stdout = '{"streams":[{"codec_name":"mp3"}],"format":{"duration":"2.5"}}'
            with self.assertRaisesRegex(RuntimeError, 'HTTP 500'):
                tts_api.synth_all([{'id': 'S1', 'narration': '旁白'}], Path(tmp), 'api:test', '+0%', 'ffprobe')
            self.assertEqual(send.call_count, 1)
            sleep.assert_not_called()
