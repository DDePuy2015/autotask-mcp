import type { QueryFilter } from '../services/autotask-http';

/** Relative ranges count local calendar dates, not fixed 24-hour periods. */
export interface TicketRelativeDateRange {
  range: 'today' | 'last7days' | 'lastweek';
  field: 'created' | 'completed' | 'lastUpdated';
  timeZone?: string;
  /** 0 = Sunday, 1 = Monday, ..., 6 = Saturday. Used only by lastweek. */
  weekStartsOn?: number;
}

/** Deployment defaults; each relative search can override these. */
export interface DateRangeDefaults {
  timeZone?: string;
  weekStartsOn?: number;
}

export interface ResolvedTicketDateRange {
  field: 'createDate' | 'completedDate' | 'lastTrackedModificationDateTime';
  startInclusive: string;
  endExclusive: string;
  timeZone: string;
  filters: QueryFilter[];
}

const DAY_MS = 86_400_000;
const DATE_FIELDS = {
  created: 'createDate',
  completed: 'completedDate',
  lastUpdated: 'lastTrackedModificationDateTime',
} as const;

function formatterFor(timeZone: unknown): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || !timeZone || /^[+-]/.test(timeZone)) {
    throw new Error('timeZone must be a valid IANA timezone, for example America/New_York or UTC.');
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new Error('timeZone must be a valid IANA timezone, for example America/New_York or UTC.');
  }
}

function requireWeekStart(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error('weekStartsOn must be an integer from 0 (Sunday) to 6 (Saturday).');
  }
}

/** Validate deployment defaults without consulting the host timezone. */
export function resolveDateRangeDefaults(defaults: DateRangeDefaults = {}): Required<DateRangeDefaults> {
  const timeZone = defaults.timeZone ?? 'America/New_York';
  const weekStartsOn = defaults.weekStartsOn ?? 1;
  formatterFor(timeZone);
  requireWeekStart(weekStartsOn);
  return { timeZone, weekStartsOn };
}

function localWallTime(instant: number, formatter: Intl.DateTimeFormat): number {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function localDate(instant: number, formatter: Intl.DateTimeFormat): number {
  const date = new Date(localWallTime(instant, formatter));
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Find local midnight using offsets on both sides of the boundary. A repeated
 * midnight uses its first occurrence. If midnight is skipped, find the first
 * valid instant of the date (or the next date for a wholly skipped date).
 */
function startOfDay(calendarDate: number, formatter: Intl.DateTimeFormat): number {
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = calendarDate + hours * 3_600_000;
    offsets.add(localWallTime(sample, formatter) - sample);
  }
  const midnights = [...offsets]
    .map(offset => calendarDate - offset)
    .filter(candidate => localWallTime(candidate, formatter) === calendarDate);
  if (midnights.length) return Math.min(...midnights);

  let before = calendarDate - 2 * DAY_MS;
  let after = calendarDate + 2 * DAY_MS;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (localDate(middle, formatter) < calendarDate) before = middle;
    else after = middle;
  }
  return after;
}

/**
 * Validate structured input and resolve it once using an injectable clock.
 * Validation precedes client initialization/network access in searchTickets.
 * Legacy explicit date strings are forwarded untouched when no range is set.
 */
export function resolveTicketDateRange(
  options: {
    relativeDateRange?: unknown;
    createdAfter?: unknown;
    createdBefore?: unknown;
    lastActivityAfter?: unknown;
  },
  defaults: DateRangeDefaults = {},
  clock: () => Date = () => new Date(),
): ResolvedTicketDateRange | undefined {
  if (options.relativeDateRange === undefined) return undefined;
  if (['createdAfter', 'createdBefore', 'lastActivityAfter'].some(key =>
    options[key as keyof typeof options] !== undefined)) {
    throw new Error('relativeDateRange cannot be combined with createdAfter, createdBefore, or lastActivityAfter.');
  }
  const input = options.relativeDateRange;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('relativeDateRange must be an object with range and field.');
  }
  const raw = input as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter(key => !['range', 'field', 'timeZone', 'weekStartsOn'].includes(key));
  if (unknownKeys.length) throw new Error(`Unknown relativeDateRange parameter: ${unknownKeys.join(', ')}.`);
  if (raw.range !== 'today' && raw.range !== 'last7days' && raw.range !== 'lastweek') {
    throw new Error('relativeDateRange.range must be today, last7days, or lastweek.');
  }
  if (raw.field !== 'created' && raw.field !== 'completed' && raw.field !== 'lastUpdated') {
    throw new Error('relativeDateRange.field must be created, completed, or lastUpdated.');
  }
  if (raw.weekStartsOn !== undefined && raw.range !== 'lastweek') {
    throw new Error('relativeDateRange.weekStartsOn applies only to lastweek.');
  }
  const resolvedDefaults = resolveDateRangeDefaults(defaults);
  // Null is invalid input, not an instruction to silently use defaults.
  const timeZone = raw.timeZone === undefined ? resolvedDefaults.timeZone : raw.timeZone;
  const weekStartsOn = raw.weekStartsOn === undefined ? resolvedDefaults.weekStartsOn : raw.weekStartsOn;
  const formatter = formatterFor(timeZone);
  requireWeekStart(weekStartsOn);
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Relative-date clock must return a valid Date.');
  const today = localDate(now.getTime(), formatter);
  let start = today;
  let end = today + DAY_MS;
  if (raw.range === 'last7days') start -= 6 * DAY_MS;
  if (raw.range === 'lastweek') {
    const daysIntoWeek = (new Date(today).getUTCDay() - weekStartsOn + 7) % 7;
    end = today - daysIntoWeek * DAY_MS;
    start = end - 7 * DAY_MS;
  }
  const startInclusive = new Date(startOfDay(start, formatter)).toISOString();
  const endExclusive = new Date(startOfDay(end, formatter)).toISOString();
  const field = DATE_FIELDS[raw.field];
  return {
    field, startInclusive, endExclusive, timeZone: timeZone as string,
    filters: [
      { op: 'gte', field, value: startInclusive },
      { op: 'lt', field, value: endExclusive },
    ],
  };
}
