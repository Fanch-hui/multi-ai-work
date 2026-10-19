import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { State } from '../src/core/state.js';
import type { Artifact, Task } from '../src/domain/types.js';
import { saveEvidence } from '../scripts/presets/acceptance-evidence.js';
import { fixturePreset } from './preset-package-fixture.js';

it('snapshots reconstructable artifact content when its cache file is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preset-evidence-')),
    state = new State(join(root, 'core'));
  try {
    const task: Task = {
      id: 'task',
      botId: 'member',
      conversationId: 'conversation',
      status: 'completed',
      goal: '模拟验收',
      expectedOutput: '可读成果',
      dependencyIds: [],
      runIds: ['run'],
      artifactIds: ['artifact'],
      requestId: 'request',
      depth: 0,
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:01Z',
    };
    state.storage.put('bots', { id: task.botId, skillIds: ['skill'] });
    state.storage.put('tool_operations', {
      id: 'operation',
      runId: 'run',
      name: 'read_skill',
      status: 'succeeded',
      result: { id: 'skill', name: '模拟技能' },
    });
    const content = '完整工具结果：保留实际执行记录。',
      key = 'artifact-text:artifact';
    const artifact: Artifact = {
      id: 'artifact',
      name: '工具完整结果.txt',
      taskId: task.id,
      botId: task.botId,
      conversationId: task.conversationId,
      createdAt: task.updatedAt,
      mimeType: 'text/plain',
      purpose: 'intermediate',
      path: join(root, 'core/artifacts/artifact/tool-output.txt'),
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      contentSource: { kind: 'stored-text', key },
    };
    state.storage.put('artifacts', artifact);
    state.storage.setMetadata(key, content);
    expect(existsSync(artifact.path)).toBe(false);
    const output = join(root, 'evidence');
    const report = await saveEvidence(
      { state },
      fixturePreset(),
      { scenario: '模拟资料', prompt: '保存记录', files: [], reviewChecks: ['保留完整记录'] },
      task,
      output,
      'fixture-model',
      1000,
      'antigravity',
    );
    expect(await readFile(join(output, '1-工具完整结果.txt'), 'utf8')).toBe(content);
    expect(report.checks).toEqual({
      completed: true,
      boundSkillRead: true,
      readableArtifact: true,
    });
    expect(report.scope.provider).toBe('antigravity');
    const run = JSON.parse(await readFile(join(output, 'run.json'), 'utf8'));
    expect(run.artifacts[0].sha256).toBe(artifact.sha256);
    expect(existsSync(artifact.path)).toBe(false);
  } finally {
    state.storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
