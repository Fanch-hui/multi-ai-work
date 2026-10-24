import type { State } from './state.js';
import type { Bot, Conversation, Task } from '../domain/types.js';
import { ChiefContextService } from './chief-contexts.js';
import { terminal } from '../domain/task-status.js';

export function migrateChiefWork(state: State) {
  const s = state.storage;
  if (s.metadata('chief-work-v1')) return;
  const contexts = new ChiefContextService(state);
  const settings = state.settings();
  const routines = s.all<{ id: string; conversationId: string }>('routines');
  const routineRooms = new Set(routines.map((item) => item.conversationId));
  s.transaction(() => {
    const rooms = s
      .all<Conversation>('conversations')
      .filter(
        (room) =>
          room.purpose === 'chief' &&
          room.kind === 'private' &&
          room.chiefId === settings.mainBotId,
      );
    if (routineRooms.has(settings.mainConversationId!)) {
      const replacement = rooms
        .filter((room) => !room.archived && !routineRooms.has(room.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const previous = s.get<Conversation>('conversations', settings.mainConversationId!);
      const home = replacement ?? {
        ...previous!,
        id: randomUUID(),
        name: s.get<Bot>('bots', settings.mainBotId!)!.name,
        chiefRole: 'home' as const,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      if (!replacement) {
        s.put('conversations', home);
        rooms.push(home);
      }
      s.setMetadata('settings', { ...settings, mainConversationId: home.id });
    }
    const homeId = state.settings().mainConversationId!;
    const home = s.get<Conversation>('conversations', homeId);
    const chief = s.get<Bot>('bots', settings.mainBotId!);
    if (home?.model && chief && (home.model !== chief.model || home.reasoning !== chief.reasoning))
      s.put('bots', {
        ...chief,
        model: home.model,
        reasoning: home.reasoning,
        revision: chief.revision + 1,
      });
    for (const room of rooms) {
      const routine = routines.find((item) => item.conversationId === room.id);
      let chiefRole: Conversation['chiefRole'] = routine ? 'routine' : 'history';
      if (room.id === homeId) chiefRole = 'home';
      s.put('conversations', {
        ...room,
        chiefHomeId: homeId,
        chiefRole,
      });
      const active = s
        .byField<Task>('tasks', 'conversationId', room.id)
        .some((task) => !task.kind && !terminal(task.status));
      if (room.id === homeId || routine || active) {
        const context = contexts.create({
          title: room.name,
          conversationId: room.id,
          workspaceId: room.workspaceId,
          routineId: routine?.id,
        });
        if (room.id === homeId)
          s.setMetadata(`chief-focus:${homeId}`, { contextId: context.id, revision: 0 });
      }
    }
    s.setMetadata('chief-work-v1', true);
  });
}
import { randomUUID } from 'node:crypto';
