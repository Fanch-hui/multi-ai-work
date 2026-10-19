import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/core/state.js';
import { authorizedSkills, importSkillPackage, syncOfficeSkills } from '../src/core/skills.js';
import { createToolRegistry } from '../src/tools/index.js';
import type { Bot } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';

describe('skill packages', () => {
  let directory: string, state: State;
  const registry = createToolRegistry();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'team-skill-package-'));
    state = new State(join(directory, 'app'));
  });
  afterEach(async () => {
    state.storage.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('copies package resources and reads them within the authorized package', async () => {
    const source = join(directory, 'source');
    await mkdir(join(source, 'scripts'), { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\ndescription: Test package\n---\nUse scripts/check.py.',
    );
    await writeFile(join(source, 'scripts', 'check.py'), 'print("original")');
    const skill = await importSkillPackage(state, join(source, 'SKILL.md'));
    await writeFile(join(source, 'scripts', 'check.py'), 'print("changed")');
    expect(await readFile(join(skill.resourceRoot!, 'scripts', 'check.py'), 'utf8')).toBe(
      'print("original")',
    );
    const context = {
      skills: [skill],
      signal: new AbortController().signal,
    } as ToolExecutionContext;
    expect(
      await registry.execute(
        'read_skill',
        { skillId: skill.id, resource: 'scripts/check.py' },
        context,
      ),
    ).toMatchObject({ content: 'print("original")', nextOffset: null });
    await expect(registry.execute('read_skill', { skillId: 'other' }, context)).rejects.toThrow(
      '未授权',
    );
    await writeFile(join(state.dataDirectory, 'skills', 'outside.txt'), 'outside');
    await expect(
      registry.execute('read_skill', { skillId: skill.id, resource: '../outside.txt' }, context),
    ).rejects.toThrow('超出授权');
  });

  it('migrates Office grants once without granting commands or restoring revoked grants', () => {
    const chief = state.storage.all<Bot>('bots')[0]!;
    const reader = { ...chief, id: 'reader', toolNames: ['read_file'], skillIds: [] };
    const executor = {
      ...chief,
      id: 'executor',
      toolNames: ['run_command', 'register_artifact'],
      skillIds: [],
    };
    state.storage.put('bots', reader);
    state.storage.put('bots', executor);
    state.storage.setMetadata('office-tool-grants-v1', false);
    syncOfficeSkills(state);
    const migrated = state.storage.get<Bot>('bots', reader.id)!;
    expect(migrated.toolNames).toEqual(['read_file', 'read_skill', 'load_workspace_dependencies']);
    expect(state.storage.get<Bot>('bots', executor.id)!.toolNames).toContain('render_document');
    expect(
      authorizedSkills(state, { ...migrated, toolNames: [] }).every((skill) => skill.bundled),
    ).toBe(true);
    state.storage.put('bots', reader);
    syncOfficeSkills(state);
    expect(state.storage.get<Bot>('bots', reader.id)!.toolNames).toEqual(['read_file']);
  });
  it('makes built-in skills available without tool grants and keeps imported skills opt-in', async () => {
    const bot = { ...state.storage.all<Bot>('bots')[0]!, toolNames: [], skillIds: ['chosen'] };
    for (const [id, bundled] of [
      ['office', true],
      ['chosen', false],
      ['other', false],
    ] as const)
      state.storage.put('skills', { id, name: id, bundled, content: id, path: '/skills/' + id });
    const skills = authorizedSkills(state, bot);
    expect(skills.map((skill) => skill.id)).toContain('office');
    expect(skills.map((skill) => skill.id)).toContain('chosen');
    expect(skills.map((skill) => skill.id)).not.toContain('other');
    const context = { skills, signal: new AbortController().signal } as ToolExecutionContext;
    expect(await registry.execute('read_skill', { skillId: 'office' }, context)).toMatchObject({
      content: 'office',
    });
    await expect(registry.execute('read_skill', { skillId: 'other' }, context)).rejects.toThrow(
      '未授权',
    );
  });
});
