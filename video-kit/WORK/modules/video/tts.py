"""TTS narration synthesis with word-level timestamps.

Reads narration text from the blueprint; never hardcodes script copy.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

import edge_tts

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
FALLBACK_VOICES = ["zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural", "zh-CN-liaoning-XiaobeiNeural"]


def ffprobe_duration(ffprobe: str, media: Path) -> float:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(media)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


async def _synth(text: str, voice: str, rate: str, mp3_path: Path) -> list[dict]:
    com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary", proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"))
    words: list[dict] = []
    audio = bytearray()
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
        elif chunk["type"] == "WordBoundary":
            words.append({
                "text": chunk["text"],
                "offset": round(chunk["offset"] / 1e7, 4),
                "duration": round(chunk["duration"] / 1e7, 4),
            })
    if not audio:
        raise RuntimeError(f"edge-tts returned no audio for voice={voice}")
    mp3_path.write_bytes(bytes(audio))
    return words


def synth_segment(text: str, mp3_path: Path, voice: str, rate: str, ffprobe: str) -> dict:
    """Synthesize one segment. Returns audio path, measured duration, word timings."""
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    last_err: Exception | None = None
    for candidate in [voice] + FALLBACK_VOICES:
        try:
            words = asyncio.run(_synth(text, candidate, rate, mp3_path))
            duration = ffprobe_duration(ffprobe, mp3_path)
            return {
                "audio": str(mp3_path),
                "voice": candidate,
                "rate": rate,
                "duration": round(duration, 4),
                "words": words,
                "word_boundary_available": bool(words),
            }
        except Exception as exc:  # network / voice availability
            last_err = exc
            continue
    raise RuntimeError(f"all TTS voices failed: {last_err}")


def synth_all(segments: list[dict], audio_dir: Path, voice: str, rate: str,
              ffprobe: str, force: bool = False) -> list[dict]:
    results = []
    for seg in segments:
        sid = seg["id"]
        mp3 = audio_dir / f"{sid}.mp3"
        cache = audio_dir / f"{sid}.json"
        if cache.exists() and mp3.exists() and not force:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            # Rework safety: stale audio must never be reused for changed narration.
            if (cached.get("narration") == seg["narration"]
                    and cached.get("voice") == voice and cached.get("rate") == rate):
                results.append(cached)
                continue
        info = synth_segment(seg["narration"], mp3, voice, rate, ffprobe)
        info["id"] = sid
        info["narration"] = seg["narration"]
        cache.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
        results.append(info)
    return results