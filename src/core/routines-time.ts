import type { RoutineSchedule } from '../domain/routines.js';

type LocalTime = { year: number; month: number; day: number; hour: number; minute: number };
const minute = 60_000;
const day = 86_400_000;

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function localTime(format: Intl.DateTimeFormat, instant: number): LocalTime {
  const parts = Object.fromEntries(
    format.formatToParts(instant).map((part) => [part.type, Number(part.value)]),
  );
  return parts as LocalTime;
}

function localEpoch(value: LocalTime) {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

function localInstant(format: Intl.DateTimeFormat, value: LocalTime): number {
  const target = localEpoch(value);
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = target + hours * 60 * minute;
    offsets.add(localEpoch(localTime(format, sample)) - sample);
  }
  const candidates = [...offsets].map((offset) => target - offset);
  const matches = candidates.filter((instant) => localEpoch(localTime(format, instant)) === target);
  if (matches.length) return Math.min(...matches);
  // A missing local time shifts forward by the DST gap; repeated times use the first occurrence.
  return candidates
    .map((instant) => ({ instant, delta: localEpoch(localTime(format, instant)) - target }))
    .filter((candidate) => candidate.delta > 0)
    .sort((a, b) => a.delta - b.delta)[0]!.instant;
}

export function validateRoutineSchedule(schedule: RoutineSchedule, timeZone: string) {
  formatter(timeZone).format();
  if (schedule.kind === 'once') {
    if (!Number.isFinite(Date.parse(schedule.at)) || !/(Z|[+-]\d{2}:\d{2})$/.test(schedule.at))
      throw new Error('执行时间须为包含时区的有效时间');
    return;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
    throw new Error('执行时刻须使用 HH:mm 格式');
  if (
    schedule.kind === 'weekly' &&
    (!schedule.weekdays.length ||
      schedule.weekdays.some((value) => !Number.isInteger(value) || value < 0 || value > 6))
  )
    throw new Error('请选择有效的星期');
}

function datesAround(
  schedule: Exclude<RoutineSchedule, { kind: 'once' }>,
  zone: string,
  at: number,
) {
  const format = formatter(zone);
  const local = localTime(format, at);
  const [hour, minute] = schedule.time.split(':').map(Number);
  const midnight = Date.UTC(local.year, local.month - 1, local.day);
  const values: number[] = [];
  for (let offset = -8; offset <= 8; offset++) {
    const date = new Date(midnight + offset * day);
    if (schedule.kind === 'weekly' && !schedule.weekdays.includes(date.getUTCDay())) continue;
    values.push(
      localInstant(format, {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: hour!,
        minute: minute!,
      }),
    );
  }
  return values;
}

export function nextRoutineRun(schedule: RoutineSchedule, zone: string, after: string) {
  const boundary = Date.parse(after);
  const values =
    schedule.kind === 'once' ? [Date.parse(schedule.at)] : datesAround(schedule, zone, boundary);
  const next = values.filter((value) => value > boundary).sort((a, b) => a - b)[0];
  return next === undefined ? undefined : new Date(next).toISOString();
}

export function latestRoutineRun(
  schedule: RoutineSchedule,
  zone: string,
  firstDue: string,
  current: string,
) {
  const minimum = Date.parse(firstDue);
  const maximum = Date.parse(current);
  const values =
    schedule.kind === 'once' ? [Date.parse(schedule.at)] : datesAround(schedule, zone, maximum);
  const latest = values
    .filter((value) => value >= minimum && value <= maximum)
    .sort((a, b) => b - a)[0];
  return latest === undefined ? undefined : new Date(latest).toISOString();
}
