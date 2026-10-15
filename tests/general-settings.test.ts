import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreService } from '../src/core/service.js';
import type { Request } from '../apps/ui/src/api.js';
import { generalSettings, restoreGeneralSettings } from '../apps/ui/src/general-settings.js';

const resources: { core: CoreService; root: string }[] = [];
afterEach(async () => {
  for (const { core, root } of resources.splice(0)) {
    await core.close(); await rm(root, { recursive: true, force: true });
  }
});

describe('general settings draft', () => {
  it('loads restored settings into the draft and saves only the fields owned by the page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'general-settings-')), core = new CoreService(root);
    resources.push({ core, root });
    await core.request('settings.save', { input: { maxActiveRuns: 8, maxChildren: 12, trayEnabled: false } });
    const backup = await core.request('backup.create') as { path: string };
    await core.request('settings.save', { input: { maxActiveRuns: 2, maxChildren: 3, trayEnabled: true } });
    let draft = generalSettings(core.state.settings());
    expect(draft).toMatchObject({ maxActiveRuns: 2, maxChildren: 3 });

    const request: Request = async <T>(method: string, params?: Record<string, unknown>) => core.request(method, params) as Promise<T>;
    draft = await restoreGeneralSettings(backup.path, request, async () => core.state.snapshot());
    expect(draft).toMatchObject({ maxActiveRuns: 8, maxChildren: 12, trayEnabled: false });
    expect(Object.keys(draft).sort()).toEqual(['autoAnswerMemberQuestions', 'maxActiveRuns', 'maxChildren', 'maxCoordinationRounds', 'trayEnabled']);

    core.state.storage.setMetadata('settings', { ...core.state.settings(), defaultSearchConnectionId: 'new-search', userAvatar: 'new-avatar' });
    const laterSnapshot = core.state.snapshot();
    draft.maxChildren = 20;
    expect(generalSettings(laterSnapshot.settings).maxChildren).toBe(12);
    await request('settings.save', { input: draft });
    expect(core.state.settings()).toMatchObject({ maxActiveRuns: 8, maxChildren: 20, trayEnabled: false,
      defaultSearchConnectionId: 'new-search', userAvatar: 'new-avatar' });
  });
});
