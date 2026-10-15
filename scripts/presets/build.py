#!/usr/bin/env python3
"""Build reproducible local preset ZIPs or a reviewed GitHub Release catalog."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / 'resources' / 'agent-presets'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def skill_files(directory):
    if not (directory / 'SKILL.md').is_file():
        raise ValueError(f'Missing SKILL.md: {directory}')
    files = []
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not permitted: {path}')
        if path.is_file():
            files.append((path.relative_to(directory).as_posix(), path.read_bytes()))
    if len(files) > 1000 or sum(len(data) for _, data in files) > 64 * 1024 * 1024:
        raise ValueError(f'Skill exceeds resource limits: {directory}')
    return files


def skill_digest(files):
    lines = [json.dumps([name, sha256(data)], ensure_ascii=False, separators=(',', ':')) + '\n'
             for name, data in sorted(files)]
    return sha256(''.join(lines).encode())


def package_entries(preset, content=CONTENT):
    entries = []
    keys = [skill['key'] for skill in preset['skills']]
    roots = [skill['directory'] for skill in preset['skills']]
    if len(keys) != len(set(keys)) or len(roots) != len(set(roots)):
        raise ValueError('Duplicate skill key or resource directory')
    if any(left.startswith(right + '/') for left in roots for right in roots if left != right):
        raise ValueError('Overlapping skill resource directories')
    for skill in preset['skills']:
        directory = skill['directory']
        if any(part in ('', '.', '..') for part in directory.split('/')) or '\\' in directory:
            raise ValueError('Skill resource directory must be contained in package')
        files = skill_files(content / directory)
        if skill_digest(files) != skill['digest']:
            raise ValueError(f"Resource digest changed: {skill['key']}")
        source = skill.get('source', {})
        if source.get('stars', 0) < 200 or not re.fullmatch(r'[a-f0-9]{40}', source.get('commit', '')):
            raise ValueError(f"Unverified upstream source: {skill['key']}")
        if not all(source.get(key) for key in ('repository', 'path', 'license', 'verifiedAt')):
            raise ValueError(f"Incomplete source attribution: {skill['key']}")
        if not {'LICENSE', 'NOTICE'}.issubset({name for name, _ in files}):
            raise ValueError(f"Missing redistribution notices: {skill['key']}")
        entries.extend((directory + '/' + name, data) for name, data in files)
    entries.append(('manifest.json', (json.dumps({'formatVersion': 1, 'preset': preset},
                    ensure_ascii=False, indent=2) + '\n').encode()))
    return sorted(entries)


def write_package(path, entries):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)


def accepted(preset, report):
    item = report.get(preset['id'], {})
    return (item.get('version') == preset['version'] and item.get('runtimeAcceptance') == 'passed'
            and item.get('contentReview') == 'passed'
            and item.get('presetDigest') == preset_digest(preset)
            and item.get('skillDigests') == {s['key']: s['digest'] for s in preset['skills']}
            and bool(item.get('evidence')))


def preset_digest(preset):
    content = {key: value for key, value in preset.items() if key != 'download'}
    return sha256(json.dumps(content, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':')).encode())


def build(output, repository=None, tag=None, report_path=None, content=CONTENT):
    catalog = json.loads((content / 'catalog.json').read_text(encoding='utf-8'))
    report = json.loads(report_path.read_text(encoding='utf-8')) if report_path else {}
    if bool(repository) != bool(tag):
        raise ValueError('--repository and --tag must be supplied together')
    if repository and (not re.fullmatch(r'[\w.-]+/[\w.-]+', repository)
                       or not re.fullmatch(r'[\w.-]+', tag)):
        raise ValueError('Invalid GitHub repository or release tag')
    output.mkdir(parents=True, exist_ok=True)
    published = []
    for preset in catalog['presets']:
        filename = preset['id'] + '-' + preset['version'] + '.zip'
        destination = output / filename
        write_package(destination, package_entries(preset, content))
        if repository and accepted(preset, report):
            preset['download'] = {
                'url': f'https://github.com/{repository}/releases/download/{tag}/{filename}',
                'sha256': sha256(destination.read_bytes()), 'bytes': destination.stat().st_size}
            published.append(preset)
    (output / 'catalog.json').write_text(json.dumps({'formatVersion': 1, 'presets': published},
                                                  ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return len(catalog['presets']), len(published)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repository', help='Official GitHub owner/repository')
    parser.add_argument('--tag', help='Immutable GitHub release tag')
    parser.add_argument('--acceptance', type=Path, help='Version/digest-bound runtime evidence report')
    args = parser.parse_args()
    packages, published = build(args.output, args.repository, args.tag, args.acceptance)
    print(f'Built {packages} local packages; release catalog contains {published} accepted presets.')


if __name__ == '__main__':
    main()
