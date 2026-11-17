"""Blueprint-driven TTS driver: reads narration from the blueprint, never hardcodes copy.

Usage: python tts_driver.py <blueprint.json> <audio_dir> <voice> <rate> <ffprobe> <out.json> [--force]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tts_sapi  # noqa: E402


def main() -> int:
    bp_path, audio_dir, voice, rate, ffprobe, out_json = sys.argv[1:7]
    force = "--force" in sys.argv[7:]
    bp = json.loads(Path(bp_path).read_text(encoding="utf-8"))
    segments = [{"id": s["id"], "narration": s["narration"]} for s in bp["segments"]]
    for s in segments:
        if not s["narration"].strip():
            raise SystemExit(f"[{s['id']}] empty narration; cannot synthesize")
    audio = Path(audio_dir)
    if voice == "sapi":
        voice = f"sapi:{tts_sapi.DEFAULT_SAPI_VOICE}"
    if voice.startswith("say:"):
        from tts_say import synth_all
        results, fresh = synth_all(segments, audio, voice, rate, ffprobe, force)
        rate = "+0%"
        backend_name = "say"
    elif voice.startswith("api:"):
        from tts_api import synth_all
        results, fresh = synth_all(segments, audio, voice, rate, ffprobe, force)
        rate = "+0%"
        backend_name = "speech-api"
    else:
        from tts import synth_all
        backend_name = "sapi" if voice.startswith("sapi:") else "edge-tts"
        backend = tts_sapi.synth_all if backend_name == "sapi" else synth_all
        def cache_time(s):
            cache = audio / f"{s['id']}.json"
            return cache.stat().st_mtime_ns if cache.exists() else None
        before = {s["id"]: cache_time(s) for s in segments}
        results = backend(segments, audio, voice, rate, ffprobe, force=force)
        fresh = [s["id"] for s in segments if force or before[s["id"]] != cache_time(s)]
    offline = voice.startswith(("sapi:", "say:"))
    payload = {
        "blueprint_id": bp["blueprint_id"],
        "backend": backend_name,
        "voice_requested": voice,
        "rate": rate,
        "segments": results,
        "total_audio_seconds": round(sum(r["duration"] for r in results), 4),
        "network_syntheses_this_run": 0 if offline else len(fresh),
        "offline_syntheses_this_run": len(fresh) if offline else 0,
        "cache_hits_this_run": len(segments) - len(fresh),
        "fresh_segment_ids": fresh,
    }
    Path(out_json).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "segments": len(results),
                      "total_audio_seconds": payload["total_audio_seconds"],
                      "network_syntheses": payload["network_syntheses_this_run"],
                      "offline_syntheses": payload["offline_syntheses_this_run"],
                      "cache_hits": len(segments) - len(fresh)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
