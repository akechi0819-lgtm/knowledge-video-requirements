import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'WORK/modules/video'))
from finish_bgm import remux_mix, SR


class BackgroundMusicRemuxTest(unittest.TestCase):
    def test_padded_decoded_audio_does_not_extend_timeline(self):
        def executable(name):
            bundled = ROOT / f'node_modules/@{name}-installer/darwin-arm64/{name}'
            return os.environ.get(f'VIDEO_{name.upper()}') or shutil.which(name) or (str(bundled) if bundled.exists() else None)
        ffmpeg, ffprobe = executable('ffmpeg'), executable('ffprobe')
        if not ffmpeg or not ffprobe:
            self.skipTest('ffmpeg and ffprobe are required')
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.mp4', Path(directory) / 'mixed.mp4'
            subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i',
                            'color=black:s=64x64:r=30:d=1', '-c:v', 'libx264',
                            str(source)], check=True)
            remux_mix(ffmpeg, source, output, bytes(int(1.1 * SR) * 4), 1.0)
            probe = subprocess.run([ffprobe, '-v', 'error', '-show_entries',
                                    'format=duration:stream=codec_type,duration',
                                    '-of', 'json', str(output)], check=True,
                                   capture_output=True, text=True)
            result = json.loads(probe.stdout)
            self.assertLessEqual(abs(float(result['format']['duration']) - 1), 0.05)
            self.assertEqual({s['codec_type'] for s in result['streams']}, {'video', 'audio'})


if __name__ == '__main__':
    unittest.main()
