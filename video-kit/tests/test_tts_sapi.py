import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "WORK/modules/video"))
import tts_sapi


def fake_run(mp3, payload):
    meta = mp3.with_suffix(".sapi.json")
    wav = mp3.with_suffix(".wav")

    def run(command, **kwargs):
        if command[0] == "powershell.exe":
            wav.write_bytes(b"wav")
            meta.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        else:
            Path(command[-1]).write_bytes(b"mp3")
    return run


class SapiWordsTest(unittest.TestCase):
    def synth(self, tmp, words, ffprobe="ffprobe"):
        mp3 = Path(tmp) / "S1.mp3"
        payload = {"ok": True, "voice": "Microsoft Huihui Desktop"}
        if words is not None:
            payload["words"] = words
        with patch.object(tts_sapi.subprocess, "run", side_effect=fake_run(mp3, payload)), \
                patch("tts.ffprobe_duration", return_value=3.0):
            return tts_sapi.synth_segment("你好", mp3, "sapi:Microsoft Huihui Desktop", ffprobe)

    def test_single_word_object_from_ps_unwrap(self):
        with TemporaryDirectory() as tmp:
            info = self.synth(tmp, {"text": "你好", "audioMs": 100.0})
            self.assertEqual(info["words"], [{"text": "你好", "offset": 0.1, "duration": 2.9}])
            self.assertTrue(info["word_boundary_available"])

    def test_null_words(self):
        with TemporaryDirectory() as tmp:
            info = self.synth(tmp, None)
            self.assertEqual(info["words"], [])
            self.assertFalse(info["word_boundary_available"])

    def test_missing_words_key(self):
        with TemporaryDirectory() as tmp:
            mp3 = Path(tmp) / "S1.mp3"
            payload = {"ok": True, "voice": "Microsoft Huihui Desktop"}
            with patch.object(tts_sapi.subprocess, "run", side_effect=fake_run(mp3, payload)), \
                    patch("tts.ffprobe_duration", return_value=3.0):
                info = tts_sapi.synth_segment("你好", mp3, "sapi", "ffprobe")
            self.assertEqual(info["words"], [])

    def test_word_list_boundaries(self):
        with TemporaryDirectory() as tmp:
            info = self.synth(tmp, [{"text": "你", "audioMs": 0.0}, {"text": "好", "audioMs": 500.0}])
            self.assertEqual(info["words"], [
                {"text": "你", "offset": 0.0, "duration": 0.5},
                {"text": "好", "offset": 0.5, "duration": 2.5},
            ])


class SapiCacheTest(unittest.TestCase):
    def test_zh_fallback_voice_cache_hit(self):
        with TemporaryDirectory() as tmp:
            audio = Path(tmp)
            mp3 = audio / "S1.mp3"
            payload = {"ok": True, "voice": "Microsoft Yaoyao Desktop", "words": []}
            segments = [{"id": "S1", "narration": "你好"}]
            with patch.object(tts_sapi.subprocess, "run", side_effect=fake_run(mp3, payload)) as call, \
                    patch("tts.ffprobe_duration", return_value=3.0):
                results = tts_sapi.synth_all(segments, audio, "sapi:Microsoft Huihui Desktop", "+0%", "ffprobe")
                self.assertEqual(results[0]["voice"], "sapi:Microsoft Yaoyao Desktop")
                self.assertEqual(results[0]["requested_voice"], "sapi:Microsoft Huihui Desktop")
                saved = json.loads((audio / "S1.json").read_text(encoding="utf-8"))
                self.assertEqual(saved["requested_voice"], "sapi:Microsoft Huihui Desktop")
                count = call.call_count
                again = tts_sapi.synth_all(segments, audio, "sapi:Microsoft Huihui Desktop", "+0%", "ffprobe")
                self.assertEqual(call.call_count, count)
                self.assertEqual(again[0]["voice"], "sapi:Microsoft Yaoyao Desktop")

    def test_legacy_cache_without_requested_voice(self):
        with TemporaryDirectory() as tmp:
            audio = Path(tmp)
            (audio / "S1.mp3").write_bytes(b"mp3")
            legacy = {"id": "S1", "narration": "你好", "voice": "sapi:Microsoft Huihui Desktop",
                      "rate": "+0%", "audio": str(audio / "S1.mp3"), "duration": 3.0,
                      "words": [], "word_boundary_available": False}
            (audio / "S1.json").write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
            segments = [{"id": "S1", "narration": "你好"}]
            with patch.object(tts_sapi.subprocess, "run") as call, \
                    patch("tts.ffprobe_duration", return_value=3.0):
                results = tts_sapi.synth_all(segments, audio, "sapi:Microsoft Huihui Desktop", "+0%", "ffprobe")
                call.assert_not_called()
                self.assertEqual(results[0]["voice"], "sapi:Microsoft Huihui Desktop")


class SapiFfmpegPathTest(unittest.TestCase):
    def test_ffmpeg_from_video_ffmpeg_env(self):
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {"VIDEO_FFMPEG": "C:/tools/ffmpeg.exe"}):
            mp3 = Path(tmp) / "S1.mp3"
            payload = {"ok": True, "voice": "Microsoft Huihui Desktop", "words": []}
            with patch.object(tts_sapi.subprocess, "run", side_effect=fake_run(mp3, payload)) as call, \
                    patch("tts.ffprobe_duration", return_value=3.0):
                tts_sapi.synth_segment("你好", mp3, "sapi", "ffprobe")
            ffmpeg_commands = [c.args[0] for c in call.call_args_list if c.args[0][0] != "powershell.exe"]
            self.assertEqual(len(ffmpeg_commands), 1)
            self.assertEqual(ffmpeg_commands[0][0], "C:/tools/ffmpeg.exe")

    def test_ffmpeg_fallback_next_to_ffprobe(self):
        with TemporaryDirectory() as tmp, patch.dict(os.environ):
            os.environ.pop("VIDEO_FFMPEG", None)
            mp3 = Path(tmp) / "S1.mp3"
            payload = {"ok": True, "voice": "Microsoft Huihui Desktop", "words": []}
            ffprobe = "C:/bin/ffprobe.exe"
            with patch.object(tts_sapi.subprocess, "run", side_effect=fake_run(mp3, payload)) as call, \
                    patch("tts.ffprobe_duration", return_value=3.0):
                tts_sapi.synth_segment("你好", mp3, "sapi", ffprobe)
            ffmpeg_commands = [c.args[0] for c in call.call_args_list if c.args[0][0] != "powershell.exe"]
            self.assertEqual(ffmpeg_commands[0][0], str(Path(ffprobe).with_name("ffmpeg.exe")))


if __name__ == "__main__":
    unittest.main()