#!/usr/bin/env python3
"""Prepare an expanded preset release and the catalog for original clients."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / 'resources/agent-presets'
LEGACY_PROFESSIONS = {'legal', 'content', 'marketing', 'product', 'consulting', 'commerce',
                      'sales', 'hr', 'education', 'research', 'design', 'finance', 'student'}
PUBLIC_FIELDS = ('version', 'contentReview', 'runtimeAcceptance', 'presetDigest', 'skillDigests', 'scope')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def catalogs(catalog):
    legacy = {**catalog, 'presets': [preset for preset in catalog['presets']
                                   if set(preset['professions']).issubset(LEGACY_PROFESSIONS)]}
    return {'catalog.json': legacy, 'catalog-v2.json': catalog}


def prepare(output, acceptance, repository, tag, public):
    spec = importlib.util.spec_from_file_location('preset_build', Path(__file__).with_name('build.py'))
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    source = read_json(CONTENT / 'catalog.json')
    report = read_json(acceptance)
    missing = [preset['id'] for preset in source['presets'] if not builder.accepted(preset, report)]
    if missing:
        raise ValueError('Presets require current content and runtime acceptance: ' + ', '.join(missing))
    builder.build(output, repository, tag, acceptance)
    expanded = read_json(output / 'catalog.json')
    for name, catalog in catalogs(expanded).items():
        write_json(output / name, catalog)
    readiness = {preset['id']: {key: report[preset['id']][key] for key in PUBLIC_FIELDS}
                 for preset in source['presets']}
    write_json(CONTENT / 'readiness.json', readiness)
    assets = [output / 'catalog.json', output / 'catalog-v2.json']
    assets.extend(output / Path(preset['download']['url']).name for preset in expanded['presets'])
    (output / 'SHA256SUMS').write_text(''.join(
        hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n'
        for path in sorted(assets)), encoding='utf-8')
    if public:
        export_source(public, source, readiness)
    return len(expanded['presets'])


def export_source(public, source, readiness):
    destination = public / 'presets'
    destination.mkdir(parents=True, exist_ok=True)
    old_path = destination / 'catalog.json'
    if old_path.exists():
        old_presets = {preset['id']: preset for preset in read_json(old_path)['presets']}
        for preset in source['presets']:
            old = old_presets.get(preset['id'])
            if old and old['version'] == preset['version'] and old != preset:
                raise ValueError('Published preset content requires a new version: ' + preset['id'])
    write_json(old_path, source)
    write_json(destination / 'readiness.json', readiness)
    for directory in {skill['directory'] for preset in source['presets'] for skill in preset['skills']}:
        shutil.copytree(CONTENT / directory, destination / directory, dirs_exist_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--acceptance', type=Path, required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--public-source', type=Path)
    args = parser.parse_args()
    count = prepare(args.output, args.acceptance, args.repository, args.tag, args.public_source)
    print(f'Prepared {count} accepted presets, both client catalogs and SHA256SUMS.')


if __name__ == '__main__':
    main()
