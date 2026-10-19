import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, lstat, copyFile, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Bot, Skill } from '../domain/types.js';
import type { PresetInstallation } from '../domain/market.js';
import { workspaceRuntimeRoot } from '../tools/office-runtime.js';
import type { State } from './state.js';
import { digestSkillDirectory, parseSkillMetadata } from './market/package-resources.js';

const builtins = [
  ['office-docx', 'Word 文档', '制作、修改 Word 文档并检查文字、表格、图片与排版。'],
  ['office-pptx', 'PowerPoint 演示', '制作、修改幻灯片，导出 PDF 与页面预览。'],
  ['office-xlsx', 'Excel 工作簿', '读取、修改工作簿、公式、图表，并重算与导出。'],
  ['office-pdf', 'PDF 导出与预览', '导出 PDF、提取文字和渲染页面以核查成果。'],
];

export function syncOfficeSkills(state: State) {
  const root = join(workspaceRuntimeRoot(), 'office-skills');
  for (const [skillId, name, description] of builtins) {
    const path = join(root, skillId!, 'SKILL.md');
    if (!existsSync(path)) continue;
    const skill: Skill = {
      id: `builtin-${skillId}`,
      name: name!,
      description,
      path,
      resourceRoot: root,
      content: readFileSync(path, 'utf8'),
      version: '1',
      bundled: true,
    };
    state.storage.put('skills', skill);
  }
  if (state.storage.metadata('office-tool-grants-v1')) return;
  for (const bot of state.storage.all<Bot>('bots')) {
    const additions =
      bot.toolNames.includes('read_file') || bot.toolNames.includes('read_artifact')
        ? ['read_skill', 'load_workspace_dependencies']
        : [];
    if (bot.toolNames.includes('run_command') && bot.toolNames.includes('register_artifact'))
      additions.push('render_document');
    if (additions.length)
      state.storage.put('bots', {
        ...bot,
        toolNames: [...new Set([...bot.toolNames, ...additions])],
      });
  }
  state.storage.setMetadata('office-tool-grants-v1', true);
}

export function authorizedSkills(state: State, bot: Bot): Skill[] {
  return state.storage
    .all<Skill>('skills')
    .filter((skill) => !skill.missing && (bot.skillIds.includes(skill.id) || skill.bundled));
}

export function presetSkillIds(state: State): Set<string> {
  return new Set(
    state.storage.all<PresetInstallation>('preset_installations').flatMap((item) => item.skillIds),
  );
}

export function assertSkillAssignment(
  state: State,
  skillIds: string[],
  permittedPresetIds: readonly string[],
) {
  const privateIds = presetSkillIds(state),
    permitted = new Set(permittedPresetIds);
  if (skillIds.some((skillId) => privateIds.has(skillId) && !permitted.has(skillId))) {
    throw new Error('市场配套技能仅供绑定成员使用，请从智能体市场雇佣对应成员');
  }
}

export async function importSkillPackage(state: State, selected: string): Promise<Skill> {
  if (!isAbsolute(selected) || basename(selected) !== 'SKILL.md')
    throw new Error('请选择技能入口 SKILL.md 的绝对路径');
  const entry = await realpath(selected),
    source = dirname(entry);
  const content = await readFile(entry, 'utf8');
  if (Buffer.byteLength(content) > 128_000) throw new Error('技能文件过大，请使用独立资源文件');
  const skillId = randomUUID(),
    destination = join(state.dataDirectory, 'skills', skillId);
  let total = 0,
    count = 0;
  async function copy(directory: string) {
    for (const name of await readdir(directory)) {
      if (
        ['.git', 'node_modules', '.DS_Store', '.aws', '.codex'].includes(name) ||
        name.startsWith('.env')
      )
        continue;
      const path = join(directory, name),
        info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('技能包不能包含符号链接');
      const output = join(destination, relative(source, path));
      if (info.isDirectory()) {
        await mkdir(output, { recursive: true });
        await copy(path);
      } else if (info.isFile()) {
        total += info.size;
        count++;
        if (total > 64 * 1024 * 1024 || count > 1000)
          throw new Error('技能包超过 64 MiB 或 1000 文件限制');
        await copyFile(path, output);
      }
    }
  }
  await mkdir(destination, { recursive: true });
  try {
    await copy(source);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  let metadata: ReturnType<typeof parseSkillMetadata>, digest: string;
  try {
    metadata = parseSkillMetadata(content);
    digest = await digestSkillDirectory(destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  const skill: Skill = {
    id: skillId,
    name: metadata.name || basename(source),
    description: metadata.description ?? '',
    path: join(destination, 'SKILL.md'),
    content,
    resourceRoot: destination,
    version: metadata.version || '1',
    digest,
  };
  state.storage.put('skills', skill);
  state.changed();
  return skill;
}
