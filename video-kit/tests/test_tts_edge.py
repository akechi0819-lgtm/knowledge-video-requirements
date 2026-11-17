import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "WORK/modules/video"))
import tts


class EdgeFallbackCacheTest(unittest.TestCase):
    def test_fallback_voice_cache_hit_and_preferred_unification(self):
        async def fake_synth(text, voice, rate, mp3_path):
            if voice == tts.DEFAULT_VOICE:
                raise RuntimeError("voice unavailable")
            mp3_path.write_bytes(b"audio")
            return [{"text": "词", "offset": 0.0, "duration": 0.5}]

        with TemporaryDirectory() as tmp, \
                patch.object(tts, "_synth", new=AsyncMock(side_effect=fake_synth)) as synth, \
                patch.object(tts, "ffprobe_duration", return_value=2.0):
            segments = [{"id": "S1", "narration": "第一段"}, {"id": "S2", "narration": "第二段"}]
            results = tts.synth_all(segments, Path(tmp), tts.DEFAULT_VOICE, "+0%", "ffprobe")
            fallback = tts.FALLBACK_VOICES[0]
            self.assertEqual(results[0]["voice"], fallback)
            self.assertEqual(results[0]["requested_voice"], tts.DEFAULT_VOICE)
            # S2 must try the proven fallback first: one call instead of fail+retry.
            self.assertEqual(results[1]["voice"], fallback)
            self.assertEqual(synth.call_count, 3)
            self.assertEqual(synth.call_args_list[-1].args[1], fallback)
            saved = json.loads((Path(tmp) / "S1.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["voice"], fallback)
            self.assertEqual(saved["requested_voice"], tts.DEFAULT_VOICE)

            calls = synth.call_count
            again = tts.synth_all(segments, Path(tmp), tts.DEFAULT_VOICE, "+0%", "ffprobe")
            self.assertEqual(synth.call_count, calls)
            self.assertEqual([r["voice"] for r in again], [fallback, fallback])

    def test_legacy_cache_without_requested_voice(self):
        async def ok(text, voice, rate, mp3_path):
            mp3_path.write_bytes(b"audio")
            return []

        with TemporaryDirectory() as tmp, \
                patch.object(tts, "_synth", new=AsyncMock(side_effect=ok)) as synth, \
                patch.object(tts, "ffprobe_duration", return_value=2.0):
            audio = Path(tmp)
            (audio / "S1.mp3").write_bytes(b"audio")
            legacy = {"id": "S1", "narration": "第一段", "voice": tts.DEFAULT_VOICE, "rate": "+0%",
                      "audio": str(audio / "S1.mp3"), "duration": 2.0,
                      "words": [], "word_boundary_available": False}
            cache = audio / "S1.json"
            cache.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
            segments = [{"id": "S1", "narration": "第一段"}]
            results = tts.synth_all(segments, audio, tts.DEFAULT_VOICE, "+0%", "ffprobe")
            synth.assert_not_called()
            self.assertEqual(results[0]["voice"], tts.DEFAULT_VOICE)

            # Old caches written after a fallback stored the actual voice: must miss.
            legacy["voice"] = tts.FALLBACK_VOICES[0]
            cache.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
            results = tts.synth_all(segments, audio, tts.DEFAULT_VOICE, "+0%", "ffprobe")
            self.assertEqual(synth.call_count, 1)
            self.assertEqual(results[0]["voice"], tts.DEFAULT_VOICE)
            self.assertEqual(results[0]["requested_voice"], tts.DEFAULT_VOICE)


if __name__ == "__main__":
    unittest.main()