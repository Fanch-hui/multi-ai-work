import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'resources/agent-presets/skills/professional-spoken-script/scripts/measure_timing.py'


class SpokenTimingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def write(self, name, content):
        path = self.folder / name
        path.write_text(content, encoding='utf-8')
        return path

    def run_script(self, text, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(text), *args],
            capture_output=True,
            text=True,
            env={**os.environ, 'PYTHONIOENCODING': 'ascii'},
            check=False,
        )

    def test_chinese_counts_paragraphs_and_pause_adjusted_duration(self):
        text = self.write('zh.txt', '你好，世界！\n\n今天出发。')
        result = self.run_script(
            text, '--mode', 'zh', '--rate', '120', '--pauses', '2', '--target-seconds', '5'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['text_summary'], '你好，世界！ 今天出发。')
        self.assertEqual([row['count'] for row in data['paragraphs']], [4, 4])
        self.assertEqual(data['total_count'], 8)
        self.assertEqual(sum(row['count'] for row in data['paragraphs']), data['total_count'])
        self.assertEqual(data['reading_seconds'], 4.0)
        self.assertEqual(data['estimated_seconds'], 6.0)
        self.assertEqual(data['target_seconds'], 5.0)
        self.assertFalse(data['within_target'])

    def test_english_counts_words_across_paragraphs(self):
        text = self.write('en.txt', "Hello, world!\n\nWe're ready.")
        result = self.run_script(text, '--mode', 'en', '--rate', '120')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual([row['count'] for row in data['paragraphs']], [2, 2])
        self.assertEqual(data['unit'], 'words')
        self.assertEqual(data['total_count'], 4)
        self.assertEqual(data['estimated_seconds'], 2.0)

    def test_marked_script_removes_cues_and_keeps_emphasized_words(self):
        text = self.write('plain.txt', '今天出发')
        marked = self.write('marked.txt', '今/天【重读：出发】[语气：平静]')
        result = self.run_script(text, '--mode', 'zh', '--rate', '100', '--marked', str(marked))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_marked_script_missing_spoken_words_fails_clearly(self):
        text = self.write('plain.txt', '今天按时出发')
        marked = self.write('marked.txt', '今天出发 // [语气：轻松]')
        result = self.run_script(text, '--mode', 'zh', '--rate', '100', '--marked', str(marked))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('marked version spoken text differs', result.stderr)

    def test_non_finite_and_out_of_range_values_are_rejected(self):
        text = self.write('plain.txt', '测试')
        for rate in ('0', 'nan', 'inf'):
            with self.subTest(rate=rate):
                result = self.run_script(text, '--mode', 'zh', '--rate', rate)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('rate must be finite and positive', result.stderr)
        for pause in ('-1', 'nan', 'inf'):
            with self.subTest(pause=pause):
                result = self.run_script(
                    text, '--mode', 'zh', '--rate', '100', '--pauses', pause
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('pauses must be finite and non-negative', result.stderr)
        result = self.run_script(
            text, '--mode', 'zh', '--rate', '100', '--target-seconds', 'inf'
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('target-seconds must be finite and non-negative', result.stderr)
        result = self.run_script(
            text, '--mode', 'zh', '--rate', '100', '--target-seconds', '-1'
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('target-seconds must be finite and non-negative', result.stderr)
        result = self.run_script(text, '--mode', 'zh', '--rate', '1e-320')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside the supported numeric range', result.stderr)


if __name__ == '__main__':
    unittest.main()
