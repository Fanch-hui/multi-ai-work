import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../src/core/state.js';
import { installPresetArchive } from '../src/core/market/package.js';
import { catalogSchema } from '../src/core/market/schema.js';
import type { Skill } from '../src/domain/types.js';
import { zipFixture } from './preset-package-fixture.js';

const roots: { state: State; root: string }[] = [];
afterEach(async () => { for (const { state, root } of roots.splice(0)) { state.storage.close(); await rm(root, { recursive: true, force: true }); } });

describe('prepared career content', () => {
  it('installs all prepared manifests with their real self-contained skill resources and license records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'market-content-')), state = new State(join(root, 'data'));
    roots.push({ state, root });
    const source = join(process.cwd(), 'resources/agent-presets');
    const catalog = catalogSchema.parse(JSON.parse(await readFile(join(source, 'catalog.json'), 'utf8')));
    const unique = new Set<string>();
    for (const preset of catalog.presets) {
      const entries: Record<string, string | Buffer> = { 'manifest.json': JSON.stringify({ formatVersion: 1, preset }) };
      for (const skill of preset.skills) {
        unique.add(skill.digest);
        const files = await readdir(join(source, skill.directory), { recursive: true, withFileTypes: true });
        for (const file of files.filter(file => file.isFile())) {
          const path = join(file.parentPath, file.name);
          const relative = path.slice(source.length + 1).replaceAll('\\', '/');
          entries[relative] = await readFile(path);
        }
      }
      const path = join(root, `${preset.id}.zip`); await writeFile(path, zipFixture(entries));
      const installed = await installPresetArchive(state, path, 'official', preset);
      expect(installed.skillIds).toHaveLength(preset.skills.length);
      expect(installed.skillIds.length).toBeGreaterThanOrEqual(1);
      for (const skillId of installed.skillIds) {
        const skill = state.storage.get<Skill>('skills', skillId)!;
        expect(skill.content).toBe(await readFile(join(skill.resourceRoot!, 'SKILL.md'), 'utf8'));
        expect(skill.source?.stars).toBeGreaterThanOrEqual(200);
        expect(await readFile(join(skill.resourceRoot!, 'LICENSE'), 'utf8')).not.toBe('');
      }
    }
    expect(state.storage.all<Skill>('skills').filter(skill => !skill.bundled)).toHaveLength(unique.size);
  }, 180_000);
});
