import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'WORK/modules/video'))
import tts_say


class SayTest(unittest.TestCase):
    def test_segment_and_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            def run(command, **kwargs):
                if command[0] == 'say':
                    Path(command[command.index('-o') + 1]).write_bytes(b'aiff')
                elif command[0] == 'ffmpeg':
                    Path(command[-1]).write_bytes(b'mp3')
                else:
                    class Result:
                        stdout = json.dumps({'format': {'duration': '3.2'}})
                    return Result()
            segment = [{'id': 'S01', 'narration': '你好'}]
            with patch('tts_say.subprocess.run', side_effect=run) as call:
                results, fresh = tts_say.synth_all(segment, Path(directory), 'say:Tingting', '+0%', 'ffprobe')
                self.assertEqual(fresh, ['S01'])
                self.assertEqual(results[0]['duration'], 3.2)
                self.assertEqual(results[0]['words'], [])
                results, fresh = tts_say.synth_all(segment, Path(directory), 'say:Tingting', '+0%', 'ffprobe')
                self.assertEqual(fresh, [])
                self.assertEqual(call.call_count, 3)

if __name__ == '__main__':
    unittest.main()
