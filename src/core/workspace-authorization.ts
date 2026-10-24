import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { Conversation, Workspace } from '../domain/types.js';
import type { State } from './state.js';

function contains(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function canonicalTarget(target: string): string {
  let current = target;
  while (true) {
    try {
      return path.join(realpathSync(current), path.relative(current, target));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function containsWorkspace(workspace: Workspace, target: string) {
  if (contains(workspace.path, target)) return true;
  try {
    return contains(realpathSync(workspace.path), target);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false;
    throw error;
  }
}

export function workspaceResolver(state: State, botId: string, room: Conversation) {
  return (workspaceId?: string, target?: string, write = false): Workspace => {
    const workspaces = state.storage.all<Workspace>('workspaces');
    const chief = botId === state.settings().mainBotId && room.chiefId === botId;
    let absolute = target && path.isAbsolute(target) ? path.resolve(target) : undefined;
    if (absolute) {
      const targetPath = absolute;
      if (!workspaces.some((item) => containsWorkspace(item, targetPath)))
        absolute = canonicalTarget(absolute);
    }
    const matched = absolute
      ? workspaces
          .filter((item) => containsWorkspace(item, absolute))
          .sort((a, b) => b.path.length - a.path.length)[0]
      : undefined;
    const explicit = workspaceId ? workspaces.find((item) => item.id === workspaceId) : undefined;
    if (workspaceId && (!explicit || explicit.enabled === false))
      throw new Error('工作目录不存在或授权已撤销');
    if (explicit && absolute && !containsWorkspace(explicit, absolute))
      throw new Error('路径超出授权工作目录');
    const selectedId = matched?.id ?? workspaceId ?? room.workspaceId;
    const selected = workspaces.find((item) => item.id === selectedId);
    if (!selected || selected.enabled === false) throw new Error('工作目录不存在或授权已撤销');
    if (!chief && selected.id !== room.workspaceId) throw new Error('路径超出任务授权工作目录');
    if (absolute && !containsWorkspace(selected, absolute)) throw new Error('路径超出授权工作目录');
    if (write && !selected.writable) throw new Error('工作目录仅允许读取');
    return selected;
  };
}

const writeTools = new Set([
  'write_artifact',
  'write_file',
  'edit_file',
  'delete_file',
  'run_command',
  'render_document',
  'scan_code_security',
]);
const fileTools = new Set([
  ...writeTools,
  'read_file',
  'list_directory',
  'find_files',
  'search_text',
  'register_artifact',
]);

export function resolveToolWorkspace(
  name: string,
  args: Record<string, unknown>,
  context: import('../domain/tools.js').ToolExecutionContext,
) {
  if (!fileTools.has(name) || !context.resolveWorkspace) return context;
  const requested = context.resolveWorkspace(
    typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
  );
  for (const key of ['path', 'workdir', 'outputDirectory']) {
    if (typeof args[key] === 'string' && !path.isAbsolute(args[key]))
      args[key] = path.resolve(requested.path, args[key]);
  }
  let target = args.path;
  if (name === 'run_command') target = args.workdir;
  if (name === 'render_document') {
    const artifact =
      typeof args.artifactId === 'string' ? context.findArtifact(args.artifactId) : undefined;
    target =
      args.outputDirectory ??
      (artifact?.workingPath ? path.dirname(artifact.workingPath) : args.path);
  }
  const workspace = context.resolveWorkspace(
    typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
    typeof target === 'string' ? target : undefined,
    writeTools.has(name),
  );
  return { ...context, workspace };
}

export function overlappingWorkspaces(state: State, firstId: string, secondId: string) {
  if (firstId === secondId) return true;
  const first = state.storage.get<Workspace>('workspaces', firstId);
  const second = state.storage.get<Workspace>('workspaces', secondId);
  return (
    !!first &&
    !!second &&
    (containsWorkspace(first, second.path) || containsWorkspace(second, first.path))
  );
}
