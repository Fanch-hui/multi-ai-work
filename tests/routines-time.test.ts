import { describe, expect, it } from 'vitest';
import {
  latestRoutineRun,
  nextRoutineRun,
  validateRoutineSchedule,
} from '../src/core/routines-time.js';

describe('例行工作时区计算', () => {
  it('按当地时刻跨越夏令时，缺失时刻向后平移，重复时刻只取第一次', () => {
    expect(
      nextRoutineRun({ kind: 'daily', time: '02:30' }, 'America/New_York', '2026-03-07T08:00:00Z'),
    ).toBe('2026-03-08T07:30:00.000Z');
    const repeated = { kind: 'daily', time: '01:30' } as const;
    expect(nextRoutineRun(repeated, 'America/New_York', '2026-11-01T04:00:00Z')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(nextRoutineRun(repeated, 'America/New_York', '2026-11-01T05:45:00Z')).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });

  it('支持半小时夏令时与跨月周计划', () => {
    expect(
      nextRoutineRun(
        { kind: 'daily', time: '02:15' },
        'Australia/Lord_Howe',
        '2026-10-03T12:00:00Z',
      ),
    ).toBe('2026-10-03T15:45:00.000Z');
    expect(
      nextRoutineRun(
        { kind: 'weekly', time: '09:00', weekdays: [1] },
        'Asia/Shanghai',
        '2026-10-31T13:00:00Z',
      ),
    ).toBe('2026-11-02T01:00:00.000Z');
  });

  it('多年漏跑仅取最新时刻，一次性规则执行后没有下次', () => {
    expect(
      latestRoutineRun(
        { kind: 'daily', time: '09:00' },
        'Asia/Shanghai',
        '2020-01-01T01:00:00Z',
        '2026-10-23T02:00:00Z',
      ),
    ).toBe('2026-10-23T01:00:00.000Z');
    expect(
      nextRoutineRun(
        { kind: 'once', at: '2026-10-23T01:00:00Z' },
        'Asia/Shanghai',
        '2026-10-23T01:00:00Z',
      ),
    ).toBeUndefined();
  });

  it('拒绝无效时区、钟表时间、星期和无时区的日期', () => {
    expect(() =>
      validateRoutineSchedule({ kind: 'daily', time: '09:00' }, 'Invalid/Zone'),
    ).toThrow();
    expect(() => validateRoutineSchedule({ kind: 'daily', time: '24:00' }, 'UTC')).toThrow();
    expect(() =>
      validateRoutineSchedule({ kind: 'weekly', time: '09:00', weekdays: [] }, 'UTC'),
    ).toThrow();
    expect(() =>
      validateRoutineSchedule({ kind: 'once', at: '2026-10-23T09:00' }, 'UTC'),
    ).toThrow();
  });
});
