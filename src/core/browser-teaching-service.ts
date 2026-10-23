import { z } from 'zod';
import type {
  BrowserTeachingDraft,
  BrowserTeachingHostMethod,
} from '../domain/browser-teaching.js';
import type { BrowserSession } from '../domain/work-browser.js';
import type { State } from './state.js';
import { required } from './errors.js';
export class BrowserTeachingService {
  private recording = new Set<string>();
  constructor(
    private state: State,
    private host?: (
      method: BrowserTeachingHostMethod,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}
  async finishSession(sessionId: string) {
    if (!this.host || !this.recording.has(sessionId)) return null;
    const draft = (await this.host('teaching.stop', { sessionId })) as BrowserTeachingDraft | null;
    this.persist(draft);
    this.recording.delete(sessionId);
    return draft;
  }
  async close() {
    if (!this.host) return;
    for (const sessionId of this.recording) await this.finishSession(sessionId);
  }
  private persist(draft: BrowserTeachingDraft | null) {
    if (!draft || draft.status !== 'draft') return;
    const old =
      this.state.storage.metadata<BrowserTeachingDraft[]>('browser-teaching-drafts') ?? [];
    const previous = old.find((item) => item.id === draft.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(draft)) return;
    this.state.storage.setMetadata(
      'browser-teaching-drafts',
      [...old.filter((item) => item.id !== draft.id), draft].slice(-100),
    );
    this.state.changed();
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'teaching.drafts')
      return this.state.storage.metadata<BrowserTeachingDraft[]>('browser-teaching-drafts') ?? [];
    const sessionId = z.string().min(1).max(200).parse(params.sessionId);
    const session = required(
      this.state.storage.get<BrowserSession>('browser_sessions', sessionId),
      '工作浏览器会话不存在',
    );
    if (session.status !== 'handoff') throw new Error('请先接管浏览器，再启动或读取示范教学');
    if (!this.host) throw new Error('示范教学需要桌面 App');
    if (!['teaching.start', 'teaching.status', 'teaching.stop'].includes(method))
      throw new Error('不支持的示范教学操作');
    const draft = (await this.host(method as BrowserTeachingHostMethod, {
      sessionId,
    })) as BrowserTeachingDraft | null;
    if (draft?.status === 'recording') this.recording.add(sessionId);
    else this.recording.delete(sessionId);
    this.persist(draft);
    return draft;
  }
}
