import { appendFile, access } from 'node:fs/promises';
import path from 'node:path';

const target = process.platform === 'win32' ? 'win-x64' : 'mac-arm64';
let bundledRuntime = false;
try { await access(path.join('workspace-runtime', target, 'runtime.json')); bundledRuntime = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const lines = [
  '## Validation scope',
  '- Core and build: locked dependency installation, TypeScript, complete Vitest suite, preset package tests, production build.',
  `- Bundled Office rendering and document preview tests: ${bundledRuntime ? 'runtime present; see test results' : 'skipped because this job does not prepare the bundled runtime'}.`,
  ...(process.platform === 'win32' ? ['- POSIX signal process-group test: skipped on Windows; Windows process lifecycle tests remain enabled.'] : []),
  '- Desktop packaging and copied-package Core/Office smoke checks run separately in Validate desktop packages.',
  '- Provider account login, real model calls, installer interaction, and UI acceptance require separate validation.',
];
await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
