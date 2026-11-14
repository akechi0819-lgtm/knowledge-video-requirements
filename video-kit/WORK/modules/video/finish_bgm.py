"""vibe-knowledge 强制 BGM 的 Windows 适配混音段（基础档）。

复用 vendor skill 原件：fit_bgm.py（按小节裁默认 BGM）与 bgm_force.calibrate()
（说话时 BGM 比人声低 10 dB 的统一校准）。本文件只做 Windows/本管线适配：
从成片解码人声轨、由 mapping+plans 生成说话掩码、混音后 remux（视频流 copy）。

用法: python finish_bgm.py <out_dir> <ffmpeg> <ffprobe>
输入: <out_dir>/final.mp4, mapping.json, plans.json
产出: final.mp4(含BGM), final_voice_only.mp4(混音前), bgm.wav, bgm.beats.json, bgm.json
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

MODULE_DIR = Path(__file__).resolve().parent
VK = MODULE_DIR.parents[2] / "vendor" / "vibe-knowledge" / "skills" / "vibe-knowledge"
SR = 48000


def decode_audio(ffmpeg: str, src: Path, filters: list[str] | None = None) -> np.ndarray:
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(src), "-map", "0:a", *(filters or []),
         "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    out_dir, ffmpeg, ffprobe = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    final = out_dir / "final.mp4"
    mapping = json.loads((out_dir / "mapping.json").read_text(encoding="utf-8"))
    plans = {p["id"]: p for p in json.loads((out_dir / "plans.json").read_text(encoding="utf-8"))}
    total = mapping["final_duration_sec"]

    # SAPI has sharp transients that can pin the final mix at the true-peak limit.
    filters = ["-af", "acompressor=threshold=0.10:ratio=5:attack=0.25:release=45"]
    narr = decode_audio(ffmpeg, final, filters if "--compress-narration" in sys.argv[4:] else None)
    n = len(narr)
    speech = np.zeros(n, dtype=bool)
    for seg in mapping["segments"]:
        p = plans[seg["id"]]
        a = int(round((seg["start_sec"] + p["audioStart"]) * SR))
        b = int(round((seg["start_sec"] + p["audioStart"] + p["audioDuration"]) * SR))
        speech[max(0, a):min(n, b)] = True
    if not speech.any():
        raise SystemExit("no speech windows found; refusing to calibrate BGM against silence")

    env = {**os.environ, "PATH": str(Path(ffmpeg).parent) + os.pathsep + os.environ.get("PATH", ""),
           "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    bgm_wav = out_dir / "bgm.wav"
    subprocess.run(
        [sys.executable, str(VK / "tools" / "fit_bgm.py"), str(bgm_wav), "--seconds", f"{total:.3f}"],
        check=True, env=env,
    )
    bgmt = decode_audio(ffmpeg, bgm_wav)
    if len(bgmt) < n:
        bgmt = np.concatenate([bgmt, np.zeros((n - len(bgmt), 2), np.float32)])
    bgmt = bgmt[:n]
    fade = min(int(0.3 * SR), n)
    bgmt[:fade] *= np.linspace(0, 1, fade)[:, None]

    sys.path.insert(0, str(VK / "tools"))
    import bgm_force
    state = {"auto": True, "dropped": [], "user_bgm": None}
    bgmt = bgm_force.calibrate(bgmt, narr, speech, out_dir, state)

    mix = narr + bgmt
    # skill 交付响度目标 ≈ -14.5 LUFS / ≤ -1 dBTP：静态增益（不压缩动态，
    # 人声/BGM 比例保持不变），增益取响度与真峰值两个约束的较小值。
    pcm0 = (np.clip(mix, -1, 1) * 32767).astype("<i2").tobytes()
    r = subprocess.run([ffmpeg, "-nostats", "-f", "s16le", "-ac", "2", "-ar", str(SR),
                        "-i", "-", "-af", "ebur128=peak=true", "-f", "null", "-"],
                       input=pcm0, capture_output=True)
    err = r.stderr.decode("utf-8", "replace")
    lufs = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", err)[-1])
    tp = float(re.findall(r"Peak:\s+(-?[\d.]+) dBFS", err)[-1])
    gain_db = min(-14.5 - lufs, -1.5 - tp)
    mix *= 10 ** (gain_db / 20)
    peak = float(np.max(np.abs(mix))) if n else 0.0
    limited = peak > 0.99
    if limited:
        mix *= 0.99 / peak
    pcm = (np.clip(mix, -1, 1) * 32767).astype("<i2").tobytes()
    tmp = out_dir / "final_bgm_tmp.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", str(final),
         "-f", "s16le", "-ac", "2", "-ar", str(SR), "-i", "-",
         "-map", "0:v", "-map", "1:a", "-c:v", "copy",
         "-c:a", "aac", "-b:a", "160k", "-ar", str(SR), "-ac", "2",
         "-movflags", "+faststart", str(tmp)],
        input=pcm, check=True,
    )
    new_dur = float(subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(tmp)],
        capture_output=True, text=True, check=True,
    ).stdout.strip())
    if abs(new_dur - total) > 0.05:
        tmp.unlink()
        raise SystemExit(f"BGM remux changed duration {total} -> {new_dur}; mapping would be wrong")
    voice_only = out_dir / "final_voice_only.mp4"
    final.replace(voice_only)
    tmp.replace(final)

    rep = json.loads((out_dir / "bgm.json").read_text(encoding="utf-8"))
    print(json.dumps({"ok": True, "bgm": rep.get("has_bgm"),
                      "voice_gap_db": rep.get("voice_gap_db"),
                      "gain_applied_db": rep.get("gain_applied_db"),
                      "loudness_before_lufs": round(lufs, 1),
                      "loudness_gain_db": round(gain_db, 1),
                      "peak_limited": limited, "final_duration_sec": round(new_dur, 3)},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
