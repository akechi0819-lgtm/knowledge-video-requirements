"""macOS say narration, measured as a whole segment without word timings."""
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import warnings


def synth_all(segments, audio, voice, rate, ffprobe, force=False):
    name = voice.removeprefix('say:')
    if not name:
        raise ValueError('say 配音需要音色名称')
    if rate != '+0%':
        warnings.warn(f"接口/系统配音不支持语速 {rate}，已按默认 +0% 合成")
        rate = '+0%'
    audio.mkdir(parents=True, exist_ok=True)
    results, fresh = [], []
    for segment in segments:
        sid, narration = segment['id'], segment['narration']
        mp3, cache = audio / f'{sid}.mp3', audio / f'{sid}.json'
        signature = dict(id=sid, narration=narration, voice=voice, rate=rate)
        if not force and mp3.exists() and cache.exists():
            saved = json.loads(cache.read_text(encoding='utf-8'))
            if all(saved.get(k) == v for k, v in signature.items()):
                results.append({**saved, 'audio': str(mp3)})
                continue
        with TemporaryDirectory(dir=audio) as temp:
            aiff, sample = Path(temp) / 'speech.aiff', Path(temp) / 'speech.mp3'
            subprocess.run(['/usr/bin/say', '-v', name, '-o', str(aiff), narration], check=True)
            subprocess.run([os.environ.get('VIDEO_FFMPEG', 'ffmpeg'), '-v', 'error', '-y', '-i', str(aiff), '-codec:a', 'libmp3lame', str(sample)], check=True)
            probe = subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(sample)], check=True, capture_output=True, text=True)
            duration = float(json.loads(probe.stdout)['format']['duration'])
            if duration <= 0:
                raise ValueError(f'[{sid}] 配音时长无效')
            result = dict(**signature, audio=str(mp3), duration=duration, words=[], word_boundary_available=False)
            cache.unlink(missing_ok=True)
            sample.replace(mp3)
            cache.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        results.append(result)
        fresh.append(sid)
    return results, fresh
