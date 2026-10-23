export interface BrowserTeachingStep {
  action: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'scroll';
  url: string;
  target?: string;
  instruction: string;
}
export interface BrowserTeachingDraft {
  id: string;
  sessionId: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  status: 'recording' | 'draft';
  steps: BrowserTeachingStep[];
  truncated: boolean;
}
export type BrowserTeachingHostMethod = 'teaching.start' | 'teaching.status' | 'teaching.stop';
