import type { Message, RunEvent, Snapshot } from '../../../src/domain/types.js';
import type {
  MessagePage,
  SnapshotCursor,
  SnapshotDelta,
  SnapshotView,
} from '../../../src/domain/snapshot-sync.js';

type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export interface TeamView {
  data?: Snapshot;
  error: string;
  loadingHistory: boolean;
  nextBefore?: number;
}
export function upsert<T extends { id: string }>(items: T[], updates: T[]): T[] {
  if (!updates.length) return items;
  const values = new Map(items.map((item) => [item.id, item]));
  let changed = false;
  for (const item of updates) {
    changed ||= values.get(item.id) !== item;
    values.set(item.id, item);
  }
  if (!changed) return items;
  return [...values.values()];
}
const compareMessages = (a: Message, b: Message) =>
  a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt);
function orderedMessages(items: Message[], updates: Message[]) {
  if (!updates.length) return items;
  const merged = upsert(items, updates);
  if (merged === items) return items;
  // Streaming edits keep their position; only newly published or moved messages need sorting.
  if (merged.some((item, index) => index > 0 && compareMessages(merged[index - 1], item) > 0))
    merged.sort(compareMessages);
  return merged;
}
const recentEvents = (items: RunEvent[], updates?: RunEvent[]) =>
  updates?.length ? upsert(items, updates).slice(-200) : items;

export class TeamSnapshotStore {
  private value: TeamView = { error: '', loadingHistory: false };
  private cursor?: SnapshotCursor;
  private conversationId?: string;
  // Conversation selection invalidates every in-flight read for the previous room.
  private selectionGeneration = 0;
  // A full view replaces the loaded range and invalidates older page requests.
  private historyGeneration = 0;
  private pending?: Promise<void>;
  private refreshQueued = false;
  private fullRefreshQueued = false;
  constructor(
    private request: Request,
    private publish: (view: TeamView) => void,
  ) {}
  current() {
    return this.value;
  }
  private emit(patch: Partial<TeamView>) {
    if (Object.entries(patch).every(([key, value]) => this.value[key as keyof TeamView] === value))
      return;
    this.value = { ...this.value, ...patch };
    this.publish(this.value);
  }
  select(conversationId?: string) {
    if (this.conversationId === conversationId) return;
    this.conversationId = conversationId;
    this.selectionGeneration++;
    this.emit({
      data: this.value.data && { ...this.value.data, messages: [] },
      nextBefore: undefined,
      loadingHistory: false,
    });
    void this.refresh(true);
  }
  refresh(full = false): Promise<void> {
    this.refreshQueued = true;
    this.fullRefreshQueued ||= full;
    if (!this.pending)
      this.pending = this.drain().finally(() => {
        this.pending = undefined;
        if (this.refreshQueued) void this.refresh();
      });
    return this.pending;
  }
  private async drain() {
    while (this.refreshQueued) {
      this.refreshQueued = false;
      const generation = this.selectionGeneration;
      const room = this.conversationId;
      const full = this.fullRefreshQueued;
      this.fullRefreshQueued = false;
      try {
        await this.refreshSelection(generation, room, full);
      } catch (error) {
        if (generation === this.selectionGeneration) {
          this.emit({ error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  private async refreshSelection(generation: number, room: string | undefined, full: boolean) {
    let delta: SnapshotDelta | undefined;
    if (!full && this.cursor) {
      delta = await this.request<SnapshotDelta>('state.changes', {
        cursor: this.cursor,
        conversationId: room,
        businessDeltas: true,
      });
    }
    if (generation !== this.selectionGeneration) return;
    if (delta && this.value.data && delta.cursor.epoch === this.cursor?.epoch) {
      this.applyDelta(delta);
    }
    if (delta && !delta.reset) {
      this.cursor = delta.cursor;
      return;
    }
    await this.reloadSelection(generation, room, delta);
  }
  private async reloadSelection(
    generation: number,
    room: string | undefined,
    delta?: SnapshotDelta,
  ) {
    const sameEpoch = !delta || delta.cursor.epoch === this.cursor?.epoch;
    const from = sameEpoch ? this.value.data?.messages[0]?.sequence : undefined;
    const result = await this.request<SnapshotView>('state.view', { conversationId: room, from });
    if (generation !== this.selectionGeneration) return;
    this.cursor = result.cursor;
    this.historyGeneration++;
    const messages = orderedMessages([], result.snapshot.messages);
    this.emit({
      data: { ...result.snapshot, messages },
      nextBefore: result.history?.nextBefore,
      error: '',
    });
  }
  private applyDelta(delta: SnapshotDelta) {
    const data = this.value.data!;
    const updates = {
      messages: orderedMessages(data.messages, delta.messages),
      tasks: upsert(data.tasks, delta.tasks),
      runs: upsert(data.runs, delta.runs),
      processes: upsert(data.processes, delta.processes),
      conversations: upsert(
        delta.conversations ?? data.conversations,
        delta.conversationUpdates ?? [],
      ),
      taskPlans: upsert(data.taskPlans, delta.taskPlans ?? []),
      taskInputs: upsert(data.taskInputs, delta.taskInputs ?? []),
      events: recentEvents(data.events, delta.events),
    };
    const changed = Object.entries(updates).some(
      ([key, value]) => data[key as keyof typeof updates] !== value,
    );
    this.emit({ data: changed ? { ...data, ...updates } : data, error: '' });
  }
  async loadMore() {
    const room = this.conversationId;
    const before = this.value.nextBefore;
    if (!room || !before || this.value.loadingHistory) return;
    const generation = this.selectionGeneration;
    const historyGeneration = this.historyGeneration;
    this.emit({ loadingHistory: true });
    try {
      const page = await this.request<MessagePage>('conversations.messages', { id: room, before });
      if (
        generation !== this.selectionGeneration ||
        historyGeneration !== this.historyGeneration ||
        !this.value.data
      )
        return;
      // A newer live message always wins over an overlapping history response.
      const messages = orderedMessages(page.messages, this.value.data.messages);
      this.emit({ data: { ...this.value.data, messages }, nextBefore: page.nextBefore, error: '' });
    } catch (error) {
      if (generation === this.selectionGeneration)
        this.emit({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (generation === this.selectionGeneration) this.emit({ loadingHistory: false });
    }
  }
}
