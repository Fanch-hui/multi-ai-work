import { expect, it } from 'vitest';
import { publicError } from '../src/core/errors.js';

it('preserves a diagnostic path containing a key prefix inside a word', () => {
  const message =
    "EEXIST: file already exists, mkdir 'D:\\validation\\risk-fixes-20261014-1584e8a\\data-file'";
  expect(publicError(new Error(message))).toBe(message);
});

it.each(['sk-unit-test-0000000000000000', 'eyJ000000000000000000000000'])(
  'redacts a standalone credential from a diagnostic: %s',
  (credential) => {
    expect(publicError(new Error('Authentication failed: ' + credential))).toBe(
      'Authentication failed: [已隐藏]',
    );
  },
);
