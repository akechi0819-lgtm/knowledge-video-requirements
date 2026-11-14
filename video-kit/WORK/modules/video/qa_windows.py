"""vibe-knowledge qa.py 的 Windows 适配质检（基础档）。

保留原件四项可移植检查：接触表、响度(LUFS/真峰值)、>3s 静止检测、BGM 相关性强制检查。
原件的 macOS Vision OCR 回读在 Windows 不可用：ocr.txt 写占位说明，屏幕文字核对
改由接触表人工 review 承担（见 docs/vibe-knowledge-integration.md 的替代清单）。

用法: python qa_windows.py <成片.mp4> <ffmpeg> <ffprobe> [--every 3] [--out qa/]
退出码: 0 通过(可带警告); 2 缺 BGM（skill 规定不能交付）
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MODULE_DIR = Path(__file__).resolve().parent
VK = MODULE_DIR.parents[2] / "vendor" / "vibe-knowledge" / "skills" / "vibe-knowledge"


def arg(n, d):
    return sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d


def bgm_residual_correlation(mixed, voice, bgm):
    n = min(len(mixed), len(voice), len(bgm))
    if n == 0:
        raise ValueError("空音频无法检查背景音乐")
    mixed, voice, bgm = [x[:n].astype(np.float64) for x in (mixed, voice, bgm)]
    power = np.dot(voice, voice)
    if power == 0:
        raise ValueError("人声轨为空，无法检查背景音乐")
    residual = mixed - np.dot(mixed, voice) / power * voice
    norm = np.linalg.norm(residual) * np.linalg.norm(bgm)
    return float(np.dot(residual, bgm) / norm) if norm > 1e-9 else 0.0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    src, ffmpeg, ffprobe = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    every = float(arg("--every", "3"))
    out = Path(arg("--out", str(src.parent / "qa")))
    out.mkdir(parents=True, exist_ok=True)
    fr = out / "frames"
    fr.mkdir(exist_ok=True)
    for f in fr.glob("*.png"):
        f.unlink()
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(src),
                    "-vf", f"fps=1/{every},scale=1280:-2", str(fr / "f_%04d.png")], check=True)
    fs = sorted(fr.glob("f_*.png"))

    (out / "ocr.txt").write_text(
        "Windows 无 macOS Vision OCR（swiftc 不可用），本文件为占位说明。\n"
        "屏幕文字（字幕/标签/出处脚注）核对以 sheet.jpg 接触表人工 review 为准。\n",
        encoding="utf-8")

    w = 400
    ims = [Image.open(f) for f in fs]
    h = int(w * ims[0].height / ims[0].width)
    cols = 6
    sheet = Image.new("RGB", (cols * w, ((len(ims) + cols - 1) // cols) * h), "black")
    d = ImageDraw.Draw(sheet)
    font = None
    for fp in ["C:/Windows/Fonts/arial.ttf",
               "/System/Library/Fonts/Supplemental/Arial.ttf",
               "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
               "/usr/share/fonts/dejavu/DejaVuSans.ttf"]:
        if Path(fp).exists():
            font = ImageFont.truetype(fp, 20)
            break
    if font is None:
        font = ImageFont.load_default()
    for i, im in enumerate(ims):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(im.resize((w, h)), (x, y))
        t = i * every
        d.rectangle([x, y, x + 70, y + 24], fill="black")
        d.text((x + 4, y + 2), f"{int(t // 60)}:{int(t % 60):02d}", fill="yellow", font=font)
    sheet.save(out / "sheet.jpg", quality=82)

    r = subprocess.run([ffmpeg, "-nostats", "-i", str(src), "-vn",
                        "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    I = re.findall(r"I:\s+(-?[\d.]+) LUFS", r)
    P = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", r)
    fz = subprocess.run([ffmpeg, "-nostats", "-i", str(src), "-an",
                         "-vf", "fps=10,scale=480:-2,freezedetect=n=0.002:d=3", "-f", "null", "-"],
                        capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", fz)]
    durs = [float(x) for x in re.findall(r"freeze_duration: ([\d.]+)", fz)]
    if len(durs) < len(starts):
        durs.append(float(subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, check=True).stdout) - starts[-1])
    frozen = list(zip(starts, durs))
    (out / "freeze.txt").write_text(
        "\n".join(f"{int(a // 60)}:{a % 60:04.1f}  静止 {d:.1f} 秒" for a, d in frozen), encoding="utf-8")

    print(f"→ {out / 'sheet.jpg'}  {len(fs)} 帧")
    print(f"响度 {I[-1] if I else '?'} LUFS  真峰值 {P[-1] if P else '?'} dBTP（skill 目标 ≈ -14.5 LUFS / ≤ -1 dBTP）")
    if frozen:
        print(f"⚠ 静止画面 {len(frozen)} 段（>3 秒）→ {out / 'freeze.txt'}")
        if any(d > 10 for _, d in frozen):
            print("⚠⚠ 有超过 10 秒的冻结，多半是渲染出事，重录后再交付")
    else:
        print("静止检测：没有超过 3 秒的静止画面")

    def _pcm(f, t, sr=4000):
        b = subprocess.run([ffmpeg, "-v", "error", "-t", str(t), "-i", str(f),
                            "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                           capture_output=True, check=True).stdout
        return np.frombuffer(b, np.float32).copy()

    # Compare the actual fitted music after removing the voice component. The
    # final mix applies a global gain, so estimate that gain from the voice track.
    ref = _pcm(src.parent / "bgm.wav", 1e6)
    voice = _pcm(src.parent / "final_voice_only.mp4", 1e6)
    mixed = _pcm(src, 1e6)
    best = bgm_residual_correlation(mixed, voice, ref)
    bj = src.parent / "bgm.json"
    if bj.exists():
        rep = json.loads(bj.read_text(encoding="utf-8"))
        print(f"BGM 相关性 {best:.3f}；bgm.json：说话时人声比 BGM 高 {rep.get('voice_gap_db')} dB")
    else:
        print(f"BGM 相关性 {best:.3f}；无 bgm.json")
    if best < 0.12:
        print("⚠⚠ 成片里检测不到 vibe-bgm，skill 规定不能交付")
        return 2
    print("BGM 强制检查：通过")
    return 2 if frozen else 0


if __name__ == "__main__":
    raise SystemExit(main())
