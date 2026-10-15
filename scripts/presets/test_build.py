import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
import zipfile

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('preset_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ContentBuildTests(unittest.TestCase):
    def test_local_packages_keep_references_and_do_not_publish_unaccepted_content(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            total, published = build.build(output, 'example/presets', 'presets-1.0.0')
            self.assertGreater(total, 0)
            self.assertEqual(len(list(output.glob('*.zip'))), total)
            self.assertEqual(published, 0)
            catalog = json.loads((output / 'catalog.json').read_text(encoding='utf-8'))
            self.assertEqual(catalog['presets'], [])
            with zipfile.ZipFile(output / 'student-resume-advisor-1.0.0.zip') as archive:
                names = set(archive.namelist())
                self.assertIn('skills/resume-skill/templates/classic-ats.html', names)
                self.assertIn('skills/resume-skill/schema/resume-data.md', names)
                self.assertIn('skills/resume-tailor/LICENSE', names)
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual(len(manifest['preset']['skills']), 3)
                for skill in manifest['preset']['skills']:
                    prefix = skill['directory'] + '/'
                    files = [(name[len(prefix):], archive.read(name)) for name in names if name.startswith(prefix)]
                    self.assertEqual(build.skill_digest(files), skill['digest'])

    def test_release_acceptance_is_bound_to_version_and_resource_digests(self):
        preset = json.loads((build.CONTENT / 'catalog.json').read_text(encoding='utf-8'))['presets'][0]
        item = {'version': preset['version'], 'contentReview': 'passed', 'runtimeAcceptance': 'passed',
                'presetDigest': build.preset_digest(preset),
                'skillDigests': {s['key']: s['digest'] for s in preset['skills']}, 'evidence': 'actual-run-record'}
        self.assertTrue(build.accepted(preset, {preset['id']: item}))
        original = preset['instructions']
        preset['instructions'] = 'changed behavior'
        self.assertFalse(build.accepted(preset, {preset['id']: item}))
        preset['instructions'] = original
        item['skillDigests'][preset['skills'][0]['key']] = '0' * 64
        self.assertFalse(build.accepted(preset, {preset['id']: item}))

    def test_duplicate_skill_resources_are_rejected_before_writing_zip(self):
        preset = json.loads((build.CONTENT / 'catalog.json').read_text(encoding='utf-8'))['presets'][0]
        preset['skills'].append(preset['skills'][0])
        with self.assertRaisesRegex(ValueError, 'Duplicate skill'):
            build.package_entries(preset)

    def test_modified_resource_and_path_escape_are_rejected(self):
        preset = json.loads((build.CONTENT / 'catalog.json').read_text(encoding='utf-8'))['presets'][0]
        preset['skills'][0]['digest'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'digest changed'):
            build.package_entries(preset)
        preset['skills'][0]['directory'] = '../outside'
        with self.assertRaisesRegex(ValueError, 'contained'):
            build.package_entries(preset)


if __name__ == '__main__':
    unittest.main()
