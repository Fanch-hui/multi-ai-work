import type Database from 'better-sqlite3';

export function assertChiefUpgradeReady(db: Database.Database) {
  const exists = (table: string) =>
    !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
  const any = (table: string, predicate: string) =>
    exists(table) && !!db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get();
  const activeTasks = any(
    'tasks',
    "json_extract(payload, '$.status') NOT IN ('completed', 'failed', 'cancelled', 'interrupted')",
  );
  const activeRuns = any(
    'runs',
    "json_extract(payload, '$.status') IN ('running', 'waiting_approval', 'waiting_input')",
  );
  const activeProcesses = any(
    'processes',
    "json_extract(payload, '$.status') IN ('running', 'unknown')",
  );
  if (activeTasks || activeRuns || activeProcesses)
    throw new Error('请先在原版本中完成或停止全部任务，并确认命令进程已退出，再升级管家。');
  const unsettledOperations = any(
    'tool_operations',
    "json_extract(payload, '$.status') IN ('prepared', 'dispatched', 'unknown')",
  );
  const reconciliation = any('tasks', "json_extract(payload, '$.reconciliationRequired') = 1");
  if (unsettledOperations || reconciliation)
    throw new Error('请先在原版本中核查并对账尚未确认的操作，再升级管家。');
  const pendingWaits = ['approvals', 'questions', 'task_waits'].some((table) =>
    any(table, "json_extract(payload, '$.status') = 'pending'"),
  );
  if (pendingWaits) throw new Error('请先在原版本中完成或取消待回答问题与审批，再升级管家。');
}
