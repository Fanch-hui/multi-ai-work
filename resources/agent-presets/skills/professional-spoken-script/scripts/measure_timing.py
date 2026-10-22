#!/usr/bin/env python3
"""Estimate spoken-script timing from finalized UTF-8 text."""

import argparse
import hashlib
import json
import math
import re
import sys
import unicodedata
from pathlib import Path


def read_text(path):
    try:
        return Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError) as exc:
        raise ValueError(f'cannot read UTF-8 text file: {path}: {exc}') from exc


def paragraphs(text):
    return [part.strip() for part in re.split(r'\n\s*\n', text) if part.strip()]


def spoken_units(text, mode):
    if mode == 'en':
        return re.findall(r"[^\W_]+(?:['’][^\W_]+)*", text, flags=re.UNICODE)
    return [
        char for char in text
        if not char.isspace() and not unicodedata.category(char).startswith('P')
    ]


def strip_recording_marks(text):
    text = re.sub(r'【重读：([^】]*)】', r'\1', text)
    text = re.sub(r'\[语气：[^\]]*\]', '', text)
    return text.replace('//', '').replace('/', '')


def comparison_key(text, mode):
    units = spoken_units(text, mode)
    return [unit.casefold() for unit in units] if mode == 'en' else units


def estimate(text, mode, rate, pauses, target_seconds):
    parts = paragraphs(text)
    if not parts:
        raise ValueError('the text file contains no spoken text')
    counts = [len(spoken_units(part, mode)) for part in parts]
    total = sum(counts)
    if not total:
        raise ValueError('the text file contains no spoken text')
    base_seconds = total / rate * 60
    estimated_seconds = base_seconds + pauses
    if not math.isfinite(base_seconds) or not math.isfinite(estimated_seconds):
        raise ValueError('estimated duration is outside the supported numeric range')
    return {
        'mode': mode,
        'unit': 'words' if mode == 'en' else 'characters',
        'paragraphs': [
            {'index': index, 'count': count}
            for index, count in enumerate(counts, 1)
        ],
        'text_summary': re.sub(r'\s+', ' ', text).strip()[:160],
        'text_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
        'total_count': total,
        'rate_per_minute': rate,
        'reading_seconds': round(base_seconds, 3),
        'pause_budget_seconds': pauses,
        'estimated_seconds': round(estimated_seconds, 3),
        'target_seconds': target_seconds,
        'within_target': estimated_seconds <= target_seconds if target_seconds is not None else None,
        'estimate_only': True,
    }


def finite_number(value, label, allow_zero):
    number = float(value)
    if not math.isfinite(number) or number < 0 or (not allow_zero and number == 0):
        qualifier = 'positive' if not allow_zero else 'non-negative'
        raise ValueError(f'{label} must be finite and {qualifier}')
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('text_file', help='final spoken text in UTF-8')
    parser.add_argument('--mode', choices=('zh', 'en'), required=True)
    parser.add_argument('--rate', required=True, help='spoken characters or words per minute')
    parser.add_argument('--pauses', default='0', help='whole-script extra pause seconds')
    parser.add_argument('--target-seconds', help='optional target duration in seconds')
    parser.add_argument('--marked', help='optional recording-marked version to compare')
    parser.add_argument('--output', help='optional path for the JSON result')
    args = parser.parse_args(argv)
    try:
        rate = finite_number(args.rate, 'rate', allow_zero=False)
        pauses = finite_number(args.pauses, 'pauses', allow_zero=True)
        target = (finite_number(args.target_seconds, 'target-seconds', allow_zero=True)
                  if args.target_seconds is not None else None)
        text = read_text(args.text_file)
        if args.marked:
            marked = strip_recording_marks(read_text(args.marked))
            if comparison_key(marked, args.mode) != comparison_key(text, args.mode):
                raise ValueError('marked version spoken text differs from the final plain text')
        result = estimate(text, args.mode, rate, pauses, target)
        rendered = json.dumps(result, ensure_ascii=not args.output, indent=2) + '\n'
        if args.output:
            Path(args.output).write_text(rendered, encoding='utf-8')
        else:
            sys.stdout.write(rendered)
        return 0
    except (OSError, ValueError, OverflowError) as exc:
        parser.error(str(exc))


if __name__ == '__main__':
    raise SystemExit(main())
