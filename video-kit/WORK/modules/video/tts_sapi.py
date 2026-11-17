"""Offline TTS backend: Windows SAPI desktop voice (no network, no API key).

Same cache contract as tts.py so pipeline.mjs can switch backends by voice name:
voice "sapi" or "sapi:<Voice Name>" selects this backend. Word timings come from
SpeakProgress events (word start positions), durations derived from the next
boundary; quality is robotic next to edge-tts neural voices — fallback only.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

DEFAULT_SAPI_VOICE = "Microsoft Huihui Desktop"

# Executed via -Command (execution policy stays untouched); tokens replaced per call.
_PS = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$want = '__VOICE__'
$pick = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $want } | Select-Object -First 1
if (-not $pick) { $pick = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1 }
if (-not $pick) { Write-Output '{"ok":false,"reason":"no zh-CN SAPI voice installed"}'; exit 3 }
$synth.SelectVoice($pick.VoiceInfo.Name)
$words = [System.Collections.Generic.List[object]]::new()
$handler = [System.EventHandler[System.Speech.Synthesis.SpeakProgressEventArgs]] {
  param($sender, $e)
  $words.Add([pscustomobject]@{ text = $e.Text; audioMs = [math]::Round($e.AudioPosition.TotalMilliseconds, 1) })
}
$synth.add_SpeakProgress($handler)
$synth.SetOutputToWaveFile('__WAV__')
$synth.Speak('__TEXT__')
$synth.SetOutputToNull()
$synth.Dispose()
@{ ok = $true; voice = $pick.VoiceInfo.Name; words = $words } | ConvertTo-Json -Depth 5 |
  Set-Content -Path '__JSON__' -Encoding UTF8
"""


def _ps_quote(s: str) -> str:
    return s.replace("'", "''")


def synth_segment(text: str, mp3_path: Path, voice: str, ffprobe: str) -> dict:
    from tts import ffprobe_duration

    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    wav = mp3_path.with_suffix(".wav")
    meta = mp3_path.with_suffix(".sapi.json")
    want = voice.split(":", 1)[1] if ":" in voice else DEFAULT_SAPI_VOICE
    ps = (_PS.replace("__VOICE__", _ps_quote(want))
             .replace("__WAV__", _ps_quote(str(wav)))
             .replace("__JSON__", _ps_quote(str(meta)))
             .replace("__TEXT__", _ps_quote(text)))
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    info = json.loads(meta.read_text(encoding="utf-8-sig"))
    meta.unlink()
    ffmpeg = os.environ.get("VIDEO_FFMPEG") or str(Path(ffprobe).with_name("ffmpeg.exe"))
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", str(wav),
         "-codec:a", "libmp3lame", "-q:a", "2", str(mp3_path)],
        check=True,
    )
    wav.unlink()
    duration = ffprobe_duration(ffprobe, mp3_path)
    # PS 5.1 ConvertTo-Json unwraps single-element lists to objects and empty ones to null.
    raw = info.get("words") or []
    if isinstance(raw, dict):
        raw = [raw]
    words = []
    for i, w in enumerate(raw):
        start = w["audioMs"] / 1000.0
        end = raw[i + 1]["audioMs"] / 1000.0 if i + 1 < len(raw) else duration
        words.append({"text": w["text"], "offset": round(start, 4),
                      "duration": round(max(0.05, end - start), 4)})
    return {
        "audio": str(mp3_path),
        "voice": f"sapi:{info['voice']}",
        "requested_voice": voice,
        "rate": "+0%",
        "duration": round(duration, 4),
        "words": words,
        "word_boundary_available": bool(words),
    }


def synth_all(segments: list[dict], audio_dir: Path, voice: str, rate: str,
              ffprobe: str, force: bool = False) -> list[dict]:
    results = []
    for seg in segments:
        sid = seg["id"]
        mp3 = audio_dir / f"{sid}.mp3"
        cache = audio_dir / f"{sid}.json"
        if cache.exists() and mp3.exists() and not force:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            # The zh-CN fallback may pick a different voice than requested; compare requested.
            if (cached.get("narration") == seg["narration"]
                    and cached.get("requested_voice", cached.get("voice")) == voice
                    and cached.get("rate") == rate):
                results.append(cached)
                continue
        info = synth_segment(seg["narration"], mp3, voice, ffprobe)
        info["id"] = sid
        info["narration"] = seg["narration"]
        info["requested_voice"] = voice
        cache.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
        results.append(info)
    return results