export interface ModelRecovery {
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string;
  reason?: string;
}

export class ModelRecoveryPendingError extends Error {
  constructor(readonly recovery: ModelRecovery) {
    super(recovery.reason ?? '模型连接中断，正在等待恢复');
  }
}
