import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function buildSystemSpeechHelper(project) {
  if (process.platform !== 'darwin') return undefined;
  const directory = join(project, '.data', 'system-speech-build');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'system-speech-helper');
  const info = join(directory, 'Info.plist');
  await writeFile(
    info,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.multi-ai-work.desktop.speech</string>
<key>CFBundleName</key><string>multi-AI work</string>
<key>CFBundleDisplayName</key><string>multi-AI work</string>
<key>NSMicrophoneUsageDescription</key><string>在你点击麦克风后录音并识别为输入草稿。</string>
<key>NSSpeechRecognitionUsageDescription</key><string>使用系统语音识别将你的话转成文字。</string>
</dict></plist>
`,
  );
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  await execute(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-module-cache-path',
      join(directory, 'module-cache'),
      '-target',
      `${architecture}-apple-macosx14.0`,
      '-parse-as-library',
      '-O',
      '-framework',
      'AVFoundation',
      '-framework',
      'Speech',
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      info,
      join(project, 'apps/desktop/speech-native.swift'),
      '-o',
      path,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  await execute('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    'local.multi-ai-work.desktop.speech',
    '--entitlements',
    join(project, 'resources/entitlements.mac.plist'),
    path,
  ]);
  return path;
}
