import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'WORK/modules/video'))
from qa_windows import bgm_residual_correlation

class BackgroundMusicTest(unittest.TestCase):
    def test_recovers_music_despite_voice_gain_and_rejects_voice_only(self):
        rng = np.random.default_rng(42)
        voice, music = rng.normal(size=(2, 16000))
        self.assertGreater(bgm_residual_correlation(1.6 * voice + 0.2 * music, voice, music), 0.9)
        self.assertLess(bgm_residual_correlation(voice, voice, music), 0.12)
