import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_release', Path(__file__).with_name('prepare-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class CatalogCompatibilityTests(unittest.TestCase):
    def test_new_professions_keep_original_clients_on_supported_presets(self):
        old = {'id': 'legal-intake', 'professions': ['legal']}
        new = {'id': 'author-writing', 'professions': ['author']}
        mixed = {'id': 'author-research', 'professions': ['author', 'research']}
        catalog = {'formatVersion': 1, 'presets': [old, new, mixed]}
        result = release.catalogs(catalog)
        self.assertEqual(result['catalog.json']['presets'], [old])
        self.assertEqual(result['catalog-v2.json'], catalog)
        self.assertEqual(catalog['presets'], [old, new, mixed])


if __name__ == '__main__':
    unittest.main()
