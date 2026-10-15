import { Buffer } from 'node:buffer';
import type { AgentPreset } from '../src/domain/market.js';
import { digestBytes } from '../src/core/market/package-resources.js';

export const skillContent = '---\nname: evidence\ndescription: >\n  整理证据材料，\n  保留原文出处。\n---\nRead references/check.md.\n';
export const skillFiles: Record<string, string> = { 'SKILL.md': skillContent, 'references/check.md': '保留页码和原文。' };
export function fixturePreset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  const digest = digestBytes(Object.keys(skillFiles).sort().map(path =>
    `${JSON.stringify([path, digestBytes(skillFiles[path]!)])}\n`).join(''));
  return { id: 'evidence-assistant', version: '1.0.0', name: '证据整理助理', role: '整理用户提供的案件材料',
    description: '建立材料索引与证据清单。', professions: ['legal'], rank: 1, instructions: '保留原始出处，先读取配套技能。',
    examples: ['整理这组材料'], outputs: ['证据清单'], dependencies: [], platforms: ['darwin', 'win32', 'linux'],
    license: 'MIT', releaseNotes: '', skills: [{ key: 'evidence', name: '证据整理', description: '检查材料来源。',
      directory: 'skills/evidence', digest, source: { repository: 'https://github.com/example/skills', commit: 'a'.repeat(40),
        path: 'skills/evidence/SKILL.md', license: 'MIT', stars: 201, verifiedAt: '2026-10-13T00:00:00.000Z' } }], ...overrides };
}
export function fixtureEntries(preset: AgentPreset = fixturePreset()) {
  return { 'manifest.json': JSON.stringify({ formatVersion: 1, preset }), 'LICENSE': 'MIT license fixture',
    ...Object.fromEntries(Object.entries(skillFiles).map(([path, value]) => [`skills/evidence/${path}`, value])) };
}
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFixture(entries: Record<string, string | Buffer>, attributes: Record<string, number> = {}) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path), bytes = Buffer.from(value), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x0314, 4);
    index.writeUInt16LE(20, 6); index.writeUInt32LE(crc, 16); index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(attributes[path] ?? 0, 38); index.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(index, name); offset += header.length + name.length + bytes.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
