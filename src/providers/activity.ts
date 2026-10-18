import type { ProviderEvent } from '../domain/provider.js';
import type { ModelActivityKind } from '../domain/task-activity.js';

export class ModelActivity {
  private kind?: ModelActivityKind;
  private reportedAt = 0;
  constructor(private emit?: (event: ProviderEvent) => void) {}

  reset(): void { this.kind = undefined; this.reportedAt = 0; }

  report(kind: ModelActivityKind, activity: string): void {
    const now = Date.now();
    if (kind === this.kind && now - this.reportedAt < 5000) return;
    this.kind = kind;
    this.reportedAt = now;
    this.emit?.({ type: 'status', data: { phase: 'model-activity', activity, activityKind: kind } });
  }
}
