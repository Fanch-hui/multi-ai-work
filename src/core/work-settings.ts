import type { Bot, Settings } from '../domain/types.js';
import { chiefOnlyTools, chiefToolNames, hasFullToolAccess } from '../domain/tool-permissions.js';
import type { Storage } from './storage.js';

export const defaultSettings: Settings = {
  maxActiveRuns: 6,
  maxChildren: 5,
  maxCoordinationRounds: 0,
  autoAnswerMemberQuestions: true,
  trayEnabled: true,
  userAvatar: 'cat',
};
const settingKeys = [
  'maxActiveRuns',
  'maxChildren',
  'maxCoordinationRounds',
  'autoAnswerMemberQuestions',
  'trayEnabled',
  'userAvatar',
  'mainBotId',
  'mainConversationId',
  'defaultWorkspaceId',
  'defaultSearchConnectionId',
  'onboardingStatus',
];
export function workSettings(value?: Record<string, unknown>): Settings {
  const settings = {
    ...defaultSettings,
    ...Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => settingKeys.includes(key))),
  } as Settings;
  return { ...settings, maxActiveRuns: Math.min(settings.maxActiveRuns, 15) };
}
export function migrateWorkSettings(storage: Storage) {
  if (storage.metadata('work-settings-v2')) return;
  storage.setMetadata('settings', {
    ...workSettings(storage.metadata('settings')),
    maxCoordinationRounds: 0,
  });
  storage.setMetadata('work-settings-v2', true);
}
export function migrateBotPermissions(storage: Storage, chiefId?: string) {
  for (const bot of storage.all<Bot>('bots')) {
    const chief = bot.id === chiefId;
    const toolNames = chief
      ? bot.toolNames
      : bot.toolNames.filter((name) => !chiefOnlyTools.includes(name));
    const full =
      hasFullToolAccess(toolNames, chief) ||
      (chief && chiefToolNames.every((name) => toolNames.includes(name)));
    const approvalMode = bot.approvalMode ?? (full ? 'auto' : 'ask');
    if (bot.approvalMode === approvalMode && toolNames.length === bot.toolNames.length) continue;
    storage.put('bots', { ...bot, toolNames, approvalMode, revision: bot.revision + 1 });
  }
}
