import { resolveTicketDateRange, resolveDateRangeDefaults } from '../src/utils/relative-date-range';

const resolve = (range: string, now: string, overrides: Record<string, unknown> = {}) =>
  resolveTicketDateRange({ relativeDateRange: { range, field: 'created', ...overrides } }, {}, () => new Date(now))!;

describe('relative ticket dates: local calendar boundaries', () => {
  test.each([
    ['today', '2026-10-03T16:00:00Z', '2026-10-03T04:00:00.000Z', '2026-10-04T04:00:00.000Z'],
    ['last7days', '2026-10-03T16:00:00Z', '2026-09-27T04:00:00.000Z', '2026-10-04T04:00:00.000Z'],
    ['lastweek', '2026-10-03T16:00:00Z', '2026-09-21T04:00:00.000Z', '2026-09-28T04:00:00.000Z'],
    // On Sunday, lastweek is still the prior complete Monday-Sunday week.
    ['lastweek', '2026-10-04T16:00:00Z', '2026-09-21T04:00:00.000Z', '2026-09-28T04:00:00.000Z'],
    ['lastweek', '2026-10-05T16:00:00Z', '2026-09-28T04:00:00.000Z', '2026-10-05T04:00:00.000Z'],
    // Spring-forward day is 23 hours; fall-back day is 25 hours.
    ['today', '2026-03-08T16:00:00Z', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['today', '2026-11-01T16:00:00Z', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['last7days', '2026-03-08T16:00:00Z', '2026-03-02T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['last7days', '2026-11-01T16:00:00Z', '2026-10-26T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['lastweek', '2026-03-09T16:00:00Z', '2026-03-02T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['lastweek', '2026-11-02T16:00:00Z', '2026-10-26T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    // UTC midnight must not advance a New York calendar date.
    ['today', '2026-10-03T03:59:59.999Z', '2026-10-02T04:00:00.000Z', '2026-10-03T04:00:00.000Z'],
    ['today', '2026-10-03T04:00:00.000Z', '2026-10-03T04:00:00.000Z', '2026-10-04T04:00:00.000Z'],
    ['last7days', '2026-01-01T17:00:00Z', '2025-12-26T05:00:00.000Z', '2026-01-02T05:00:00.000Z'],
    ['lastweek', '2026-01-01T17:00:00Z', '2025-12-22T05:00:00.000Z', '2025-12-29T05:00:00.000Z'],
    ['last7days', '2024-03-01T17:00:00Z', '2024-02-24T05:00:00.000Z', '2024-03-02T05:00:00.000Z'],
  ])('%s at %s resolves both UTC bounds', (range, now, start, end) => {
    const result = resolve(range, now);
    expect(result.startInclusive).toBe(start);
    expect(result.endExclusive).toBe(end);
    expect(result.filters).toEqual([
      { op: 'gte', field: 'createDate', value: start },
      { op: 'lt', field: 'createDate', value: end },
    ]);
  });

  test.each([
    ['Asia/Kathmandu', '2026-10-03T12:00:00Z', '2026-10-02T18:15:00.000Z', '2026-10-03T18:15:00.000Z'],
    ['UTC', '2026-10-03T12:00:00Z', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z'],
    // Midnight gap and repeated midnight, not just a typical 02:00 DST change.
    ['America/Sao_Paulo', '2018-11-04T15:00:00Z', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z'],
    ['America/Havana', '2026-11-01T15:00:00Z', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    // Samoa skipped December 30; the end boundary is the next valid date.
    ['Pacific/Apia', '2011-12-29T22:00:00Z', '2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z'],
  ])('today in %s handles its actual midnight', (timeZone, now, start, end) => {
    const result = resolve('today', now, { timeZone });
    expect([result.startInclusive, result.endExclusive]).toEqual([start, end]);
  });

  test('Sunday-start lastweek remains a whole previous calendar week', () => {
    const result = resolve('lastweek', '2026-10-04T16:00:00Z', { weekStartsOn: 0 });
    expect([result.startInclusive, result.endExclusive]).toEqual(['2026-09-27T04:00:00.000Z', '2026-10-04T04:00:00.000Z']);
  });

  test('deployment defaults and per-call overrides are independent of the host TZ', () => {
    const clock = jest.fn(() => new Date('2026-10-03T16:00:00Z'));
    const result = resolveTicketDateRange({ relativeDateRange: { range: 'lastweek', field: 'created' } }, { timeZone: 'UTC', weekStartsOn: 0 }, clock)!;
    expect([result.startInclusive, result.endExclusive]).toEqual(['2026-09-20T00:00:00.000Z', '2026-09-27T00:00:00.000Z']);
    const overridden = resolveTicketDateRange({ relativeDateRange: { range: 'lastweek', field: 'created', timeZone: 'America/New_York', weekStartsOn: 1 } }, { timeZone: 'UTC', weekStartsOn: 0 }, clock)!;
    expect(overridden.startInclusive).toBe('2026-09-21T04:00:00.000Z');
    expect(clock).toHaveBeenCalledTimes(2); // exactly once per relative query
  });

  test.each([['created', 'createDate'], ['completed', 'completedDate'], ['lastUpdated', 'lastTrackedModificationDateTime']])('explicit field %s maps to %s', (field, apiField) => {
    const result = resolve('today', '2026-10-03T16:00:00Z', { field });
    expect(result.filters.every(filter => filter.field === apiField)).toBe(true);
  });

  test('adjacent days share an exclusive boundary across DST', () => {
    const prior = resolve('today', '2026-03-07T17:00:00Z');
    const current = resolve('today', '2026-03-08T16:00:00Z');
    expect(prior.endExclusive).toBe(current.startInclusive);
  });
});

describe('relative ticket dates: reject ambiguous input', () => {
  test.each([
    null, 'today', [], {},
    { range: 'yesterday', field: 'created' },
    { range: 'today' }, { range: 'today', field: 'lastActivity' },
    { range: 'today', field: 'created', timeZone: 'Mars/Base' },
    { range: 'today', field: 'created', timeZone: '+05:00' },
    { range: 'today', field: 'created', timeZone: null },
    { range: 'lastweek', field: 'created', weekStartsOn: null },
    { range: 'lastweek', field: 'created', weekStartsOn: '1' },
    { range: 'lastweek', field: 'created', weekStartsOn: -1 },
    { range: 'lastweek', field: 'created', weekStartsOn: 7 },
    { range: 'lastweek', field: 'created', weekStartsOn: 1.5 },
    { range: 'today', field: 'created', weekStartsOn: 1 },
    { range: 'today', field: 'created', createdAfter: '2026-01-01' },
  ])('rejects malformed range %j before reading the clock', relativeDateRange => {
    const clock = jest.fn(() => new Date());
    expect(() => resolveTicketDateRange({ relativeDateRange }, {}, clock)).toThrow();
    expect(clock).not.toHaveBeenCalled();
  });

  test.each(['createdAfter', 'createdBefore', 'lastActivityAfter'])('rejects a range combined with %s, including empty/null values', key => {
    for (const value of ['2026-01-01', '', null]) {
      expect(() => resolveTicketDateRange({ relativeDateRange: { range: 'today', field: 'created' }, [key]: value })).toThrow('cannot be combined');
    }
  });

  test('legacy dates do not read a clock or validate relative defaults', () => {
    const clock = jest.fn(() => { throw new Error('unexpected clock'); });
    expect(resolveTicketDateRange({ createdAfter: '2026-01-01', createdBefore: '2026-01-31' }, { timeZone: 'invalid' }, clock)).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
  });

  test('invalid injected clock is reported clearly', () => {
    expect(() => resolveTicketDateRange({ relativeDateRange: { range: 'today', field: 'created' } }, {}, () => new Date('bad'))).toThrow('clock must return a valid Date');
  });

  test('validates defaults with a clear timezone/week-start error', () => {
    expect(resolveDateRangeDefaults()).toEqual({ timeZone: 'America/New_York', weekStartsOn: 1 });
    expect(() => resolveDateRangeDefaults({ timeZone: 'invalid' })).toThrow('IANA timezone');
    expect(() => resolveDateRangeDefaults({ weekStartsOn: 7 })).toThrow('weekStartsOn');
  });
});
