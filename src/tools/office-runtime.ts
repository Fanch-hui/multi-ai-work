import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkspaceRuntimeManifest {
  schemaVersion: 1; platform: string; arch: string; payloadDigest: string;
  python: string; node: string; kit: string; pythonPackages: Record<string, string>;
  font: { name: string; sha256: string };
}

export interface WorkspaceDependencies {
  root: string; python: string; node: string; libreoffice: string; renderScript: string;
  checkOffice: string; fontDirectory: string; skills: { id: string; name: string; path: string }[];
  versions: { python: string; node: string; libreoffice: string; pythonPackages: Record<string, string> };
}

export function workspaceRuntimeRoot(): string {
  if (process.env.MULTI_AI_WORKSPACE_RUNTIME) return path.resolve(process.env.MULTI_AI_WORKSPACE_RUNTIME);
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) return path.join(resources, 'workspace-runtime');
  const location = fileURLToPath(import.meta.url);
  const compiled = location.split(path.sep).slice(-4, -3)[0] === 'dist';
  const project = fileURLToPath(new URL(compiled ? '../../../' : '../../', import.meta.url));
  const target = process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' : 'win-x64';
  return path.join(project, 'workspace-runtime', target);
}

export async function loadWorkspaceDependencies(root = workspaceRuntimeRoot()): Promise<WorkspaceDependencies> {
  let manifest: WorkspaceRuntimeManifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8')); }
  catch { throw new Error('Office 运行环境尚未准备，请重新安装包含完整运行环境的 App'); }
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('Office 运行环境与本机系统或架构不匹配');
  }
  const windows = manifest.platform === 'win32';
  const python = path.join(root, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']));
  const node = path.join(root, 'node', 'bin', windows ? 'node.exe' : 'node');
  const libreoffice = path.join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js');
  const assets = path.join(root, 'office-skills');
  const renderScript = path.join(assets, 'scripts', 'render_document.mjs');
  const checkOffice = path.join(assets, 'scripts', 'check_office.py');
  const fontDirectory = path.join(root, 'fonts');
  const skills = Object.entries({ 'office-docx': 'Word 文档', 'office-pptx': 'PowerPoint 演示', 'office-xlsx': 'Excel 工作簿', 'office-pdf': 'PDF 导出与预览' })
    .map(([id, name]) => ({ id: `builtin-${id}`, name, path: path.join(assets, id, 'SKILL.md') }));
  await Promise.all([python, node].map(file => access(file, windows ? constants.F_OK : constants.X_OK)));
  await Promise.all([libreoffice, renderScript, checkOffice, ...skills.map(skill => skill.path)].map(file => access(file)));
  return { root, python, node, libreoffice, renderScript, checkOffice, fontDirectory, skills,
    versions: { python: manifest.python, node: manifest.node, libreoffice: manifest.kit, pythonPackages: manifest.pythonPackages } };
}
