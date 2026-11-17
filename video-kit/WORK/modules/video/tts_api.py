"""Narration via a configured speech endpoint accepting model/input/voice/response_format."""
from contextlib import contextmanager
import base64
import binascii
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import time
import warnings


@contextmanager
def speech_response(endpoint, model, voice, narration, key, protocol):
    if protocol == "mimo":
        body = {"model": model, "messages": [{"role": "assistant", "content": narration}],
                "audio": {"voice": voice, "format": "mp3"}, "stream": False}
    else:
        body = {"model": model, "voice": voice, "input": narration, "response_format": "mp3"}
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = Request(endpoint, data=json.dumps(body).encode(), headers=headers)
    try:
        with urlopen(req, timeout=90) as response:
            yield response
    except HTTPError as error:
        raise RuntimeError(f"TTS 服务返回 HTTP {error.code}，请核对端点、模型、音色和凭据") from None


def synth_all(segments, audio, voice, rate, ffprobe, force=False):
    endpoint = os.environ.get("VIDEO_TTS_ENDPOINT")
    model = os.environ.get("VIDEO_TTS_MODEL")
    protocol = os.environ.get("VIDEO_TTS_PROTOCOL", "speech")
    if protocol not in ("speech", "mimo"):
        raise ValueError("VIDEO_TTS_PROTOCOL 只能是 speech 或 mimo")
    name = voice.removeprefix("api:")
    if not endpoint or not model or not name:
        raise ValueError("接口配音需要 VIDEO_TTS_ENDPOINT、VIDEO_TTS_MODEL 和 --voice api:<音色>")
    if rate != "+0%":
        warnings.warn(f"接口/系统配音不支持语速 {rate}，已按默认 +0% 合成")
        rate = "+0%"
    from hashlib import sha256
    service_id = sha256(endpoint.encode()).hexdigest()
    audio.mkdir(parents=True, exist_ok=True)
    results, fresh = [], []
    for segment in segments:
        sid, narration = segment["id"], segment["narration"]
        mp3, cache = audio / f"{sid}.mp3", audio / f"{sid}.json"
        signature = dict(id=sid, narration=narration, model=model, service_id=service_id,
                         voice=voice, rate=rate)
        signature["protocol"] = protocol
        if not force and mp3.exists() and cache.exists():
            saved = json.loads(cache.read_text(encoding="utf-8"))
            if all(saved.get(k) == v for k, v in signature.items()):
                results.append({**saved, "audio": str(mp3)})
                continue
        with TemporaryDirectory(dir=audio) as temp:
            sample = Path(temp) / "speech.mp3"
            # HTTPError is already a RuntimeError from speech_response and is not retried.
            for attempt in range(3):
                try:
                    with speech_response(endpoint, model, name, narration, os.environ.get("VIDEO_TTS_KEY"), protocol) as response:
                        data = response.read()
                    break
                except (URLError, TimeoutError) as error:
                    if attempt == 2:
                        raise ValueError(f"[{sid}] 配音服务连接失败：{getattr(error, 'reason', error)}") from error
                    time.sleep((2, 5)[attempt])
            if protocol == "mimo":
                try:
                    encoded = json.loads(data)["choices"][0]["message"]["audio"]["data"]
                    data = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError, KeyError, IndexError, binascii.Error) as error:
                    raise ValueError(f"[{sid}] MiMo 响应缺少有效的 Base64 音频") from error
            sample.write_bytes(data)
            probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name:format=duration", "-of", "json", str(sample)],
                check=True, capture_output=True, text=True)
            info = json.loads(probe.stdout)
            if not info.get("streams") or info["streams"][0]["codec_name"] != "mp3":
                raise ValueError(f"[{sid}] 配音接口须返回二进制 MP3")
            duration = float(info["format"]["duration"])
            if not duration > 0:
                raise ValueError(f"[{sid}] 配音时长无效")
            result = dict(**signature, audio=str(mp3), duration=duration, words=[],
                          word_boundary_available=False)
            cache.unlink(missing_ok=True)
            sample.replace(mp3)
            cache.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        results.append(result)
        fresh.append(sid)
    return results, fresh
