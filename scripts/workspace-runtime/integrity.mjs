import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export class RuntimeIntegrityError extends Error {}
const isMachO = bytes => bytes.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(bytes.readUInt32BE(0));
const executablePaths = platform => ['node/bin/' + (platform === 'win32' ? 'node.exe' : 'node'),
  platform === 'win32' ? 'python/python.exe' : 'python/bin/python3',
  `node_modules/@deepseek-ai/libreoffice-kit-${platform}-${platform === 'win32' ? 'x64' : 'arm64'}/bin/libreoffice-kit${platform === 'win32' ? '.exe' : ''}`];

function requiredPaths(manifest) {
  return [...executablePaths(manifest.platform), 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js',
    'office-skills/scripts/render_document.mjs', 'office-skills/scripts/check_office.py',
    ...['docx', 'pptx', 'xlsx', 'pdf'].map(id => `office-skills/office-${id}/SKILL.md`), `fonts/${manifest.font.name}`];
}

// Hash runtime binaries and entry resources; the rest of the payload needs only metadata checks.
export async function createRuntimeIntegrity(root, manifest) {
  const files = {};
  const critical = new Set(requiredPaths(manifest));
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === 'runtime.json') continue;
      if (item.isDirectory()) { await visit(absolute); continue; }
      const info = await lstat(absolute);
      const bytes = critical.has(relative) || /^(office-skills|fonts|licenses)\//.test(relative)
        || manifest.platform === 'darwin' && info.isFile() && (!!(info.mode & 0o111) || relative.endsWith('.bin'))
        || /\.(dylib|so(?:\.\d+)*|dll|pyd|node)$/i.test(relative) || relative.endsWith('/package.json')
        ? await readFile(absolute) : undefined;
      const checks = bytes ? { sha256: digest(bytes), ...(manifest.platform === 'darwin' && isMachO(bytes) ? { machO: true } : {}) } : {};
      if (info.isSymbolicLink()) files[relative] = { link: await readlink(absolute), ...checks };
      else if (info.isFile()) files[relative] = { size: info.size, executable: !!(info.mode & 0o111),
        ...checks };
      else throw new Error(`Unsupported runtime file: ${relative}`);
    }
  }
  await visit(root);
  for (const file of requiredPaths(manifest)) if (!files[file]) throw new Error(`Missing runtime file: ${file}`);
  return { schemaVersion: 1, files };
}

export async function assertRuntimeIntegrity(root, manifest, { allowCodeSigning = false } = {}) {
  const integrity = manifest.integrity;
  if (integrity?.schemaVersion !== 1 || !integrity.files || !Object.keys(integrity.files).length) {
    throw new RuntimeIntegrityError('Runtime file inventory is missing');
  }
  for (const required of requiredPaths(manifest)) {
    if (!integrity.files[required]) throw new RuntimeIntegrityError(`Missing runtime inventory entry: ${required}`);
  }
  for (const [relative, expected] of Object.entries(integrity.files)) {
    const absolute = path.resolve(root, relative);
    if (!relative || path.relative(root, absolute).split(path.sep).includes('..') || path.isAbsolute(relative)) {
      throw new RuntimeIntegrityError(`Invalid runtime inventory path: ${relative}`);
    }
    const info = await lstat(absolute);
    const signed = allowCodeSigning && manifest.platform === 'darwin' && expected.machO === true;
    const valid = expected.link !== undefined ? info.isSymbolicLink() && await readlink(absolute) === expected.link
      : info.isFile() && (signed || info.size === expected.size) && (manifest.platform === 'win32' || !!(info.mode & 0o111) === expected.executable);
    if (!valid || signed && !await hasMachOHeader(absolute) || !signed && expected.sha256 && digest(await readFile(absolute)) !== expected.sha256) {
      throw new RuntimeIntegrityError(`Runtime file is incomplete or changed: ${relative}`);
    }
  }
}

async function hasMachOHeader(file) {
  const handle = await open(file, 'r');
  try { const header = Buffer.alloc(4); const { bytesRead } = await handle.read(header, 0, 4, 0); return bytesRead === 4 && isMachO(header); }
  finally { await handle.close(); }
}
