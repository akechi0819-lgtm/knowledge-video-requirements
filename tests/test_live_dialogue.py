"""真实 DSH 行为回归；需要本机 DSH 可联网且有有效凭据。"""
import subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
class LiveDialogue(unittest.TestCase):
    def run_chat(self, lines):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / 'session'
            result = subprocess.run(['python3', str(ROOT/'requirement_dialogue/chat.py'), '--dir', str(dest), '--simulate'], input='\n'.join(lines)+'\n', text=True, capture_output=True, cwd=ROOT, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
            return (dest/'对话.md').read_text(), (dest/'视频需求.md').read_text() if (dest/'视频需求.md').exists() else None
    def test_quoted_confirmation_does_not_handoff(self):
        _, document = self.run_chat(['想做视频给小学生讲彩虹。有人说过“就按这个做”，但我现在还在考虑。'])
        self.assertIsNone(document)
    def test_missing_topic_does_not_handoff(self):
        _, document = self.run_chat(['想做一期《绍宋》，现在就开始。'])
        self.assertIsNone(document)
    def test_first_turn_explicit_start(self):
        _, document = self.run_chat(['我要给小学生讲雨后彩虹为什么出现，语言简单。就按这个做，出需求吧。'])
        self.assertIsNotNone(document)
        self.assertIn('彩虹', document)
    def test_change_takes_effect(self):
        _, document = self.run_chat(['想做个面向普通人的视频，讲火锅食材与美洲的联系。先做15秒样片。', '改成30秒，其他画面团队定。', '就按这个做，出需求吧。'])
        self.assertIsNotNone(document)
        self.assertIn('30', document)
