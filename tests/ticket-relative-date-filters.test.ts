import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { AutotaskMcpServer } from '../src/mcp/server';
import { loadDateRangeDefaults, loadEnvironmentConfig, mergeWithMcpConfig } from '../src/utils/config';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = {
  name: 'date-test', version: 'test',
  autotask: { username: 'test', secret: 'test', integrationCode: 'test', apiUrl: 'https://example.autotask.net/atservicesrest/' },
};
const logger = new Logger('error');

describe('relative dates reach the Autotask query body', () => {
  let fetchSpy: jest.SpyInstance;
  let clock: jest.Mock;
  let service: AutotaskService;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify({ items: [{ id: 123 }], item: { id: 123 }, pageDetails: {} }),
    } as Response);
    clock = jest.fn(() => new Date('2026-10-03T16:00:00Z'));
    service = new AutotaskService(config, logger, clock);
  });
  afterEach(() => jest.restoreAllMocks());
  const body = () => JSON.parse(fetchSpy.mock.calls[0][1].body);

  test.each([['created', 'createDate'], ['completed', 'completedDate'], ['lastUpdated', 'lastTrackedModificationDateTime']] as const)('filters %s using a bounded interval on %s', async (field, apiField) => {
    await service.searchTickets({ relativeDateRange: { range: 'today', field }, companyID: 0 });
    expect(body().filter).toEqual(expect.arrayContaining([
      { op: 'gte', field: apiField, value: '2026-10-03T04:00:00.000Z' },
      { op: 'lt', field: apiField, value: '2026-10-04T04:00:00.000Z' },
      { op: 'eq', field: 'companyID', value: 0 },
    ]));
    expect(clock).toHaveBeenCalledTimes(1);
    if (field === 'completed') expect(body().filter.some((f: { field: string }) => f.field === 'status')).toBe(false);
    else expect(body().filter).toContainEqual({ op: 'noteq', field: 'status', value: 5 });
  });

  test('completion search respects an explicit status', async () => {
    await service.searchTickets({ relativeDateRange: { range: 'lastweek', field: 'completed' }, status: 5 });
    expect(body().filter).toContainEqual({ op: 'eq', field: 'status', value: 5 });
    expect(body().filter).toContainEqual({ op: 'lt', field: 'completedDate', value: '2026-09-28T04:00:00.000Z' });
  });

  test('explicit-date behavior and inclusive createdBefore remain unchanged', async () => {
    await service.searchTickets({ createdAfter: '2026-01-01', createdBefore: '2026-01-31', lastActivityAfter: '2026-01-02T12:00:00Z' });
    expect(body().filter).toEqual(expect.arrayContaining([
      { op: 'gte', field: 'createDate', value: '2026-01-01' },
      { op: 'lte', field: 'createDate', value: '2026-01-31' },
      { op: 'gte', field: 'lastActivityDate', value: '2026-01-02T12:00:00Z' },
    ]));
    expect(clock).not.toHaveBeenCalled();
  });

  test('conflicting input is rejected before initialization or fetch', async () => {
    const initialize = jest.spyOn(service, 'initialize');
    await expect(service.searchTickets({ relativeDateRange: { range: 'today', field: 'created' }, createdAfter: '2026-01-01' })).rejects.toThrow('cannot be combined');
    expect(initialize).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a structured range is a filter and does not trigger date elicitation', async () => {
    const handler = new AutotaskToolHandler(service, logger);
    const elicitInput = jest.fn();
    handler.setServer({ elicitInput } as unknown as Parameters<typeof handler.setServer>[0]);
    const response = await handler.callTool('autotask_search_tickets', { relativeDateRange: { range: 'today', field: 'created' } });
    expect(response.isError).not.toBe(true);
    expect(elicitInput).not.toHaveBeenCalled();
    expect(body().filter).toContainEqual({ op: 'lt', field: 'createDate', value: '2026-10-04T04:00:00.000Z' });
  });

  test('handler reports malformed structured input without a query', async () => {
    const handler = new AutotaskToolHandler(service, logger);
    const response = await handler.callTool('autotask_search_tickets', { relativeDateRange: { range: 'today' } });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain('field must be');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('exact ID retrieval ignores date defaults and does not read the date clock', async () => {
    service = new AutotaskService({ ...config, dateRanges: { timeZone: 'invalid' } }, logger, () => { throw new Error('unexpected date clock'); });
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_get_ticket_details', { ticketID: 123 });
    expect(result.isError).not.toBe(true);
    expect(fetchSpy.mock.calls[0][0]).toContain('/Tickets/123');
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET');
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined();
  });

  test('ticket-number search never acquires an automatic relative date', async () => {
    await service.searchTickets({ searchTerm: 'T20200101' });
    expect(body().filter).toEqual([
      { op: 'beginsWith', field: 'ticketNumber', value: 'T20200101' },
      { op: 'noteq', field: 'status', value: 5 },
    ]);
    expect(clock).not.toHaveBeenCalled();
  });

  test('exact number lookup works with invalid date defaults and never reads the date clock', async () => {
    const ticketNumber = 'T20200101.0001';
    const row = { id: 123, ticketNumber, status: 5 };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ items: [row], pageDetails: {} })));
    const neverClock = jest.fn(() => { throw new Error('unexpected date clock'); });
    service = new AutotaskService({ ...config, dateRanges: { timeZone: 'invalid' } }, logger, neverClock);
    expect(await service.getTicketByNumber(ticketNumber, true)).toEqual(row);
    expect(body().filter).toEqual([{ op: 'eq', field: 'ticketNumber', value: ticketNumber }]);
    expect(neverClock).not.toHaveBeenCalled();
  });

  test('full ticket-number search retains equality and all-status defaults', async () => {
    await service.searchTickets({ searchTerm: 'T20200101.0001' });
    expect(body().filter).toEqual([{ op: 'eq', field: 'ticketNumber', value: 'T20200101.0001' }]);
    expect(clock).not.toHaveBeenCalled();
  });

  test('an explicitly requested range is honored on a full-number search without adding open-only status', async () => {
    await service.searchTickets({ searchTerm: 'T20200101.0001', relativeDateRange: { range: 'today', field: 'created' } });
    expect(body().filter).toEqual([
      { op: 'eq', field: 'ticketNumber', value: 'T20200101.0001' },
      { op: 'gte', field: 'createDate', value: '2026-10-03T04:00:00.000Z' },
      { op: 'lt', field: 'createDate', value: '2026-10-04T04:00:00.000Z' },
    ]);
  });

  test('router preserves exact identifier precedence when intent also contains date words', async () => {
    const handler = new AutotaskToolHandler(service, logger, true);
    const response = await handler.callTool('autotask_router', { intent: 'Find ticket T20200101.0001 from last week' });
    const routed = JSON.parse(response.content[0].text).data;
    expect(routed.suggestedTool).toBe('autotask_get_ticket_details');
    expect(routed.suggestedParams).toEqual({ ticketNumber: 'T20200101.0001', fullDetails: true });
    expect(clock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('relative-date configuration and discovery', () => {
  test('nested schema requires an explicit range and field', () => {
    const schema = TOOL_DEFINITIONS.find(tool => tool.name === 'autotask_search_tickets')!.inputSchema.properties.relativeDateRange;
    expect(schema.required).toEqual(['range', 'field']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.range.enum).toEqual(['today', 'last7days', 'lastweek']);
    expect(schema.properties.field.enum).toEqual(['created', 'completed', 'lastUpdated']);
  });

  test('settings load for Node and Worker environments and MCP argument overrides', () => {
    const dateRanges = loadDateRangeDefaults({ AUTOTASK_DATE_TIMEZONE: 'UTC', AUTOTASK_WEEK_STARTS_ON: '0' });
    expect(dateRanges).toEqual({ timeZone: 'UTC', weekStartsOn: 0 });
    const merged = mergeWithMcpConfig({ ...loadEnvironmentConfig(), dateRanges }, { dateRanges: { timeZone: 'Europe/London', weekStartsOn: 1 } });
    expect(merged.dateRanges).toEqual({ timeZone: 'Europe/London', weekStartsOn: 1 });
    expect(() => loadDateRangeDefaults({ AUTOTASK_WEEK_STARTS_ON: '1.5' })).toThrow('AUTOTASK_WEEK_STARTS_ON');
    expect(() => loadDateRangeDefaults({ AUTOTASK_DATE_TIMEZONE: 'invalid' })).toThrow('IANA timezone');
  });

  test('gateway request services preserve deployment date defaults', () => {
    const dateRanges = { timeZone: 'UTC', weekStartsOn: 0 };
    const server = new AutotaskMcpServer({ ...config, dateRanges }, logger);
    // Inspect the request factory's service, without making a vendor request.
    const handlers = (server as unknown as { buildPerRequestHandlers: (credentials: Record<string, string>) => { toolHandler: AutotaskToolHandler } }).buildPerRequestHandlers(config.autotask as Record<string, string>);
    const serviceConfig = (handlers.toolHandler as unknown as { autotaskService: { config: McpServerConfig } }).autotaskService.config;
    expect(serviceConfig.dateRanges).toEqual(dateRanges);
  });
});
