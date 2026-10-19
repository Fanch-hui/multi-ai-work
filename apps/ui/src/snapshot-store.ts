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
  for (const item of updates) values.set(item.id, item);
  return [...values.values()];
}
const orderedMessages = (items: Message[], updates: Message[]) =>
  upsert(items, updates).sort((a, b) => a.sequence - b.sequence);
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
    this.emit({ data: result.snapshot, nextBefore: result.history?.nextBefore, error: '' });
  }
  private applyDelta(delta: SnapshotDelta) {
    const data = this.value.data!;
    this.emit({
      data: {
        ...data,
        messages: orderedMessages(data.messages, delta.messages),
        tasks: upsert(data.tasks, delta.tasks),
        runs: upsert(data.runs, delta.runs),
        processes: upsert(data.processes, delta.processes),
        conversations: delta.conversations ?? data.conversations,
        events: recentEvents(data.events, delta.events),
      },
      error: '',
    });
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
