
"""Keep video console tools hidden and forward FFmpeg diagnostics on desktop."""
import os
from pathlib import Path
import subprocess
import sys


def run_media(command, **options):
    options.setdefault("creationflags", getattr(subprocess, "CREATE_NO_WINDOW", 0))
    executable = Path(command[0]).stem.lower()
    capture = os.environ.get("JIANGJIE_DESKTOP_DIAGNOSTICS") == "1" and executable in {"ffmpeg", "ffprobe"}
    if capture and not options.get("capture_output") and "stderr" not in options:
        options["stderr"] = subprocess.PIPE
    try:
        result = subprocess.run(command, **options)
    except subprocess.CalledProcessError as error:
        if capture:
            _report(error.stderr)
        raise
    if capture:
        _report(result.stderr)
    return result


def _report(stderr):
    if isinstance(stderr, bytes):
        stderr = stderr[-8192:].decode("utf-8", "replace")
    for line in (stderr or "")[-8192:].splitlines():
        print("JIANGJIE_DIAGNOSTICS ffmpeg " + line, file=sys.stderr)
