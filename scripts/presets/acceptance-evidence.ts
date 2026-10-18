import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { AgentPreset } from '../../src/domain/market.js';
import type { Artifact, ProviderKind, Task } from '../../src/domain/types.js';
import type { CoreService } from '../../src/core/service.js';

const relativePath = z.string().min(1).refine(value => !value.includes('\\') && !value.includes(':')
  && value.split('/').every(part => !!part && part !== '.' && part !== '..'), 'Fixture path must be contained in workspace');
export const fixtureSchema = z.object({ scenario: z.string().min(1), prompt: z.string().min(1),
  files: z.array(z.object({ path: relativePath, content: z.string() }).strict()),
  reviewChecks: z.array(z.string().min(1)).min(1) }).strict();
export type Fixture = z.infer<typeof fixtureSchema>;
type Operation = { id: string; runId: string; name: string; status: string; result?: { id?: string; name?: string } };

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
  return value;
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
export function presetDigest(preset: AgentPreset) {
  const { download: _download, ...content } = preset; return digest(content);
}
export async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export async function stageFixture(workspace: string, fixture: Fixture) {
  for (const file of fixture.files) {
    const destination = join(workspace, file.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, file.content, { mode: 0o600 });
  }
}
export async function saveWorkspace(source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await saveWorkspace(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}
async function collectArtifacts(core: Pick<CoreService, 'state'>, task: Task, output: string) {
  const artifacts = core.state.storage.all<Artifact>('artifacts').filter(item => item.taskId === task.id);
  const result = [];
  for (const [index, artifact] of artifacts.entries()) {
    const name = `${index + 1}-${basename(artifact.name)}`;
    const bytes = await core.state.artifactContents.read(artifact);
    await writeFile(join(output, name), bytes, { mode: 0o600 });
    const readable = ['text/plain', 'text/markdown', 'application/json'].includes(artifact.mimeType)
      && bytes.length > 0 && !bytes.includes(0);
    result.push({ name, mimeType: artifact.mimeType, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), readable });
  }
  return result;
}
export async function saveEvidence(core: Pick<CoreService, 'state'>, preset: AgentPreset, fixture: Fixture,
  task: Task, output: string, model: string, durationMs: number, provider: ProviderKind = 'qoder') {
  await mkdir(output, { recursive: true });
  const operations = core.state.storage.all<Operation>('tool_operations').filter(item => task.runIds.includes(item.runId));
  const skillIds = new Set(core.state.storage.get<{ skillIds: string[] }>('bots', task.botId)?.skillIds);
  const toolOperations = operations.map(item => ({ name: item.name, status: item.status,
    ...(item.name === 'read_skill' ? { skillId: item.result?.id, skillName: item.result?.name } : {}) }));
  const artifacts = await collectArtifacts(core, task, output);
  const checks = { completed: task.status === 'completed',
    boundSkillRead: operations.some(item => item.name === 'read_skill' && item.status === 'succeeded'
      && !!item.result?.id && skillIds.has(item.result.id)),
    readableArtifact: artifacts.some(item => item.readable) };
  const scope = { platform: process.platform, architecture: process.arch, provider, model, scenario: fixture.scenario };
  await writeFile(join(output, 'response.md'), task.result ?? '', { mode: 0o600 });
  await json(join(output, 'fixture.json'), fixture);
  await json(join(output, 'run.json'), { preset, version: preset.version, scope, status: task.status,
    error: task.error, durationMs, checks, toolOperations, artifacts, reviewStatus: 'pending_review' });
  return { version: preset.version, contentReview: 'pending_review', runtimeAcceptance: 'pending_review',
    presetDigest: presetDigest(preset), skillDigests: Object.fromEntries(preset.skills.map(skill => [skill.key, skill.digest])),
    fixtureDigest: digest(fixture), evidence: join(output, 'run.json'), scope, checks,
    reviewChecks: fixture.reviewChecks, artifacts: artifacts.map(item => join(output, item.name)) };
}
