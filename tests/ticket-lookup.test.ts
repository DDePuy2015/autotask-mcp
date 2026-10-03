import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = {
  name: 'lookup-test', version: '0',
  autotask: { username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic', apiUrl: 'https://lookup.invalid/atservicesrest/' },
};
const number = 'T20261003.0001';
const row = { id: 42, ticketNumber: number, title: 'Fixture', status: 5 };
const logger = new Logger('error');

describe('exact ticket lookup', () => {
  let service: AutotaskService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    service = new AutotaskService(config, logger);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!String(url).startsWith('https://lookup.invalid/')) throw new Error('Unexpected outbound request');
      return new Response(JSON.stringify(String(url).includes('/query') ? { items: [row], pageDetails: {} } : { item: row }));
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const body = (spy: jest.SpiedFunction<typeof fetch>) => JSON.parse(spy.mock.calls[0]![1]!.body as string);

  test.each([0, 1, 5, 99])('exact-number lookup returns status %s with only equality in the outgoing query', async status => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items: [{ ...row, status }], pageDetails: {} })));
    expect(await service.getTicketByNumber(` ${number.toLowerCase()} `, true)).toEqual({ ...row, status });
    expect(body(fetchSpy).filter).toEqual([{ op: 'eq', field: 'ticketNumber', value: number }]);
    expect(body(fetchSpy).MaxRecords).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  test('numeric lookup uses a direct ID route and returns completed tickets', async () => {
    expect(await service.getTicket(42, true)).toEqual(row);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/Tickets\/42$/);
    expect(fetchSpy.mock.calls[0]![1]?.body).toBeUndefined();
  });
  test('numeric lookup fails if the server returns a different ticket', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ item: { ...row, id: 43 } })));
    await expect(service.getTicket(42)).rejects.toThrow('requested ticket');
  });
  test('explicit compact ticketNumber is equality, while a date prefix remains broad open search', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...row, ticketNumber: 'T20261003' }], pageDetails: {} })));
    await service.getTicketByNumber('T20261003');
    expect(body(fetchSpy).filter).toEqual([{ op: 'eq', field: 'ticketNumber', value: 'T20261003' }]);
    fetchSpy.mockClear();
    await service.searchTickets({ searchTerm: 'T20261003' });
    expect(body(fetchSpy).filter).toEqual([
      { op: 'beginsWith', field: 'ticketNumber', value: 'T20261003' },
      { op: 'noteq', field: 'status', value: 5 },
    ]);
  });
  test('fully qualified searchTerm uses equality and no implicit exclusions', async () => {
    await service.searchTickets({ searchTerm: ` ${number.toLowerCase()} ` });
    expect(body(fetchSpy).filter).toEqual([{ op: 'eq', field: 'ticketNumber', value: number }]);
  });
  test('explicit search status/date/queue filters are still honored', async () => {
    await service.searchTickets({ searchTerm: number, status: 5, queueID: 7, createdAfter: '2026-10-01' });
    expect(body(fetchSpy).filter).toEqual(expect.arrayContaining([
      { op: 'eq', field: 'status', value: 5 }, { op: 'eq', field: 'queueID', value: 7 },
      { op: 'gte', field: 'createDate', value: '2026-10-01' },
    ]));
    expect(body(fetchSpy).filter).not.toEqual(expect.arrayContaining([expect.objectContaining({ op: 'noteq' })]));
  });
  test.each([[], [{ ...row, ticketNumber: 'T20261003.0002' }], [row, { ...row, id: 43 }], [{ ...row, id: undefined }]])('missing, mismatched or ambiguous records fail safely: %j', async items => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ items, pageDetails: {} })));
    if (items.length === 0) expect(await service.getTicketByNumber(number)).toBeNull();
    else await expect(service.getTicketByNumber(number)).rejects.toThrow();
  });
  test.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '42', null])('invalid numeric ID %j is rejected before I/O', async id => {
    await expect(service.getTicket(id as number)).rejects.toThrow('positive');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test.each(['', 'T20261003.*', 'T20261003.0001 extra', 42, null])('invalid ticket number %j is rejected before I/O', async value => {
    await expect(service.getTicketByNumber(value as string)).rejects.toThrow('exact');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('tool schema and handler require exactly one identifier', async () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_get_ticket_details')!;
    expect(tool.inputSchema.oneOf).toEqual([{ required: ['ticketID'] }, { required: ['ticketNumber'] }]);
    const handler = new AutotaskToolHandler(service, logger);
    for (const args of [{}, { ticketID: 42, ticketNumber: number }, { ticketID: '42' }, { ticketNumber: 'bad' }, { ticketID: 42, fullDetails: 'false' }]) {
      expect((await handler.callTool(tool.name, args)).isError).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test('exact-number tool dispatch, router and missing-ticket response', async () => {
    const handler = new AutotaskToolHandler(service, logger, true);
    const lookup = jest.spyOn(service, 'getTicketByNumber').mockResolvedValue(null);
    const result = await handler.callTool('autotask_get_ticket_details', { ticketNumber: number });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(number);
    for (const intent of [`Find ticket ${number} from last week`, `Ticket ${number}`]) {
      const routed = await handler.callTool('autotask_router', { intent });
      const route = JSON.parse(routed.content[0].text).data;
      expect(route.suggestedTool).toBe('autotask_get_ticket_details');
      expect(route.suggestedParams).toEqual({ ticketNumber: number, fullDetails: true });
    }
    expect(lookup).toHaveBeenCalledWith(number, false);
  });
});
