import { z } from 'zod';
import type { Bot, Connection, Conversation, Settings } from '../domain/types.js';
import { isChiefProvider } from '../domain/chief-provider.js';
import { isReasoningSupported } from '../domain/model-reasoning.js';
import type { State } from './state.js';
import type { TeamService } from './team.js';
import type { Storage } from './storage.js';
import { required } from './errors.js';
import { avatarSchema } from './avatars.js';

export function initializeOnboarding(storage: Storage) {
  const settings = storage.metadata<Settings>('settings')!;
  if (settings.onboardingStatus) return;
  const chief = storage.get<Bot>('bots', settings.mainBotId!);
  const connection = chief && storage.get<Connection>('connections', chief.connectionId);
  const configured = chief?.model && connection && isChiefProvider(connection.provider);
  storage.setMetadata('settings', {
    ...settings,
    onboardingStatus: configured ? 'completed' : 'pending',
  });
}

export function skipOnboarding(state: State) {
  if (state.settings().onboardingStatus !== 'completed')
    state.storage.setMetadata('settings', { ...state.settings(), onboardingStatus: 'skipped' });
  state.changed();
  return { skipped: true };
}

export function completeOnboarding(state: State, team: TeamService, input: unknown): Conversation {
  const s = state.storage;
  const result = s.transaction(() => {
    const savedId = s.metadata<string>('onboarding-conversation');
    const saved = savedId && s.get<Conversation>('conversations', savedId);
    if (saved && state.settings().onboardingStatus === 'completed')
      return required(
        s.get<Conversation>('conversations', state.settings().mainConversationId!),
        '主对话不存在',
      );
    const fields = z
      .object({
        name: z.string().trim().min(1).max(120),
        avatar: avatarSchema.optional(),
        connectionId: z.string(),
        model: z.string().trim().min(1),
        reasoning: z.string().optional(),
        workspaceId: z.string().optional(),
        contextWindow: z.number().int().min(1024).optional(),
        compactionThreshold: z.number().int().min(10).max(95).optional(),
      })
      .parse(input);
    const { workspaceId: selectedWorkspaceId, ...config } = fields;
    const workspaceId = required(
      selectedWorkspaceId ?? state.settings().defaultWorkspaceId,
      '默认工作目录不存在',
    );
    const connection = required(
      s.get<Connection>('connections', config.connectionId),
      '连接不存在',
    );
    if (!isChiefProvider(connection.provider))
      throw new Error('管家请选择 ChatGPT 或自定义 API 连接');
    if (
      !isReasoningSupported(
        connection.provider,
        connection.models.find((model) => model.id === config.model),
        config.reasoning ?? '',
      )
    )
      throw new Error('所选模型不支持此推理强度');
    required(s.get('workspaces', workspaceId), '工作目录不存在');
    const chief = team.configureChief({ ...config, reasoning: config.reasoning || undefined });
    const current = required(
      s.get<Conversation>('conversations', state.settings().mainConversationId!),
      '主对话不存在',
    );
    const room = s.put('conversations', {
      ...current,
      name: chief.name,
      workspaceId,
      model: chief.model,
      reasoning: chief.reasoning,
    });
    if (!s.getMessage(`welcome:${room.id}`))
      s.appendMessage({
        id: `welcome:${room.id}`,
        conversationId: room.id,
        authorType: 'bot',
        authorBotId: chief.id,
        content: `你好，我是${chief.name}，你的专属 AI 管家。\n\n你可以直接告诉我想完成什么，或附上一份资料。我会帮你理清目标、推进工作；需要多人协作时，组织合适的智能体，并把成果带回这里。\n\n试着说：“帮我整理这份资料，并给出下一步建议。” 你也可以先告诉我你的工作习惯。团队成员在侧栏的“我的团队”中管理，完成的成果可以在“库”中找到。\n\n今天想先从哪件事开始？`,
        artifactIds: [],
        status: 'committed',
        createdAt: new Date().toISOString(),
      });
    s.setMetadata('onboarding-conversation', room.id);
    s.setMetadata('settings', {
      ...state.settings(),
      mainConversationId: room.id,
      onboardingStatus: 'completed',
    });
    return room;
  });
  state.changed();
  return result;
}
