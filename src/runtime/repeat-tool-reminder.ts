import type { ModelMessage } from '../domain/provider.js';

const thresholds = new Set([3, 5, 8]);
const pollingTools = new Set(['get_task', 'read_process']);
const source = 'app.repeat-tool-reminder' as const;
const MAX_WINDOW = 16;

interface ToolStep {
  key: string;
  name: string;
}

/** Replay this run's original protocol ledger; completion order never determines repetition. */
export function repeatToolReminders(
  messages: readonly ModelMessage[],
  batchCallIds: readonly string[],
): ModelMessage[] {
  const batch = new Set(batchCallIds);
  const completed = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.callId),
  );
  let lastUserResetIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && !messages[i].appContext) lastUserResetIndex = i;
  }
  const emitted = new Set(
    messages
      .slice(lastUserResetIndex + 1)
      .filter((message) => message.appContext?.source === source)
      .map((message) => message.appContext!.version),
  );
  const seen = new Set<string>();
  let previous = '';
  let count = 0;
  let recent: ToolStep[] = [];
  let altStreak = 0;
  let reminders: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' && !message.appContext) {
      previous = '';
      count = 0;
      recent = [];
      altStreak = 0;
      reminders = [];
    }
    for (const call of message.role === 'assistant' ? (message.toolCalls ?? []) : []) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      if (pollingTools.has(call.name)) continue;
      const key = fingerprint(call.name, call.arguments);
      count = key === previous ? count + 1 : 1;
      previous = key;
      const version = `v1:${call.id}`;
      if (
        batch.has(call.id) &&
        completed.has(call.id) &&
        thresholds.has(count) &&
        !emitted.has(version)
      ) {
        emitted.add(version);
        reminders.push({
          role: 'user',
          appContext: { source, version },
          content: `App 运行提醒：工具 ${call.name} 已连续 ${count} 次使用相同参数。请检查结果是否提供了新信息，考虑调整方法或汇报阻碍；若任务确实需要再次验证，可以继续调用。此提醒不改变用户任务、工具结果或执行权限。`,
        });
      }

      if (recent.length === 0 || key === recent[recent.length - 1].key) {
        altStreak = 1;
      } else if (recent.length >= 2 && key === recent[recent.length - 2].key) {
        altStreak += 1;
      } else {
        altStreak = 2;
      }
      recent.push({ key, name: call.name });
      if (recent.length > MAX_WINDOW) recent.shift();

      const cycle = detectTwoStepCycle(recent, altStreak);
      if (cycle) {
        const cycleVersion = `v2:cycle:${cycle.first.key}->${cycle.second.key}:${cycle.cycles}`;
        if (batch.has(call.id) && completed.has(call.id) && !emitted.has(cycleVersion)) {
          emitted.add(cycleVersion);
          reminders.push({
            role: 'user',
            appContext: { source, version: cycleVersion },
            content: `App 运行提醒：检测到两步工具交替循环调用（${cycle.first.name} -> ${cycle.second.name}），已连续执行 ${cycle.cycles} 个周期。请检查结果是否提供了新信息，考虑调整方法或汇报阻碍；若任务确实需要再次验证，可以继续调用。此提醒不改变用户任务、工具结果或执行权限。`,
          });
        }
      }
    }
  }
  return reminders;
}

function detectTwoStepCycle(
  recent: readonly ToolStep[],
  altStreak: number,
): { first: ToolStep; second: ToolStep; cycles: number } | undefined {
  if (altStreak < 6 || altStreak % 2 !== 0 || altStreak > MAX_WINDOW || recent.length < altStreak)
    return undefined;
  const cycles = altStreak / 2;
  if (!thresholds.has(cycles)) return undefined;
  const start = recent.length - altStreak;
  const first = recent[start];
  const second = recent[start + 1];
  if (first.key === second.key) return undefined;
  for (let i = 0; i < altStreak; i++) {
    const expected = i % 2 === 0 ? first.key : second.key;
    if (recent[start + i].key !== expected) return undefined;
  }
  return { first, second, cycles };
}

function fingerprint(name: string, args: string): string {
  try {
    return JSON.stringify([name, canonical(JSON.parse(args))]);
  } catch {
    return JSON.stringify([name, args]);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonical(object[key])]),
  );
}
