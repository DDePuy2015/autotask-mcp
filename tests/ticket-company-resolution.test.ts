import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskRateLimitError, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { buildTicketSearchRoute } from '../src/handlers/ticket-search-intent';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = {
  name: 'company-fixture', version: '0',
  autotask: { username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic', apiUrl: 'https://company.invalid/atservicesrest/' },
};
const logger = new Logger('error');
const company = { id: 42, companyName: 'Acme' };
const page = (items: unknown[], nextPageUrl: string | null = null) =>
  new Response(JSON.stringify({ items, pageDetails: { nextPageUrl } }));

describe('company resolution proves exact uniqueness through the actual query', () => {
  let service: AutotaskService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    _resetRateLimitCooldowns();
    service = new AutotaskService(config, logger);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page([company]));
  });
  afterEach(() => { jest.restoreAllMocks(); _resetRateLimitCooldowns(); });
  const body = (index = 0) => JSON.parse(fetchSpy.mock.calls[index]![1]!.body as string);

  test('unique exact name uses equality, no active-only assumption, and minimal fields', async () => {
    expect(await service.resolveCompanyName(' Acme ')).toEqual({ status: 'resolved', companyID: 42 });
    expect(body()).toEqual({ filter: [{ op: 'eq', field: 'companyName', value: 'Acme' }], MaxRecords: 2, IncludeFields: ['id', 'companyName'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  test('case and whitespace normalize without stripping punctuation', async () => {
    fetchSpy.mockResolvedValue(page([{ id: 0, companyName: "O'Brien, Inc." }]));
    expect(await service.resolveCompanyName("o'brien,   Inc.")).toEqual({ status: 'resolved', companyID: 0 });
    expect(body().filter[0].value).toBe("o'brien, Inc.");
  });
  test('a later exact match disproves a unique-looking first page', async () => {
    fetchSpy.mockResolvedValueOnce(page([company], '/Companies/query/next?paging=second'))
      .mockResolvedValueOnce(page([{ ...company, id: 43 }]));
    const result = await service.resolveCompanyName('Acme');
    expect(result.status).toBe('ambiguous');
    expect(result).not.toHaveProperty('companyID');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![1]!.method).toBe('POST');
    expect(body(1)).toEqual(body());
  });
  test('one exact match is accepted only after an empty terminal page', async () => {
    fetchSpy.mockResolvedValueOnce(page([company], '/Companies/query/next?paging=second'))
      .mockResolvedValueOnce(page([]));
    expect(await service.resolveCompanyName('Acme')).toEqual({ status: 'resolved', companyID: 42 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  test('two exact rows stop safely even if more pages exist', async () => {
    fetchSpy.mockResolvedValue(page([company, { ...company, id: 43 }], '/Companies/query/next?paging=more'));
    expect((await service.resolveCompanyName('Acme')).status).toBe('ambiguous');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  test('duplicate rows never become a unique selection by deduplication', async () => {
    fetchSpy.mockResolvedValue(page([company, company]));
    expect((await service.resolveCompanyName('Acme')).status).toBe('ambiguous');
  });
  test('a sole partial match still requires explicit confirmation', async () => {
    fetchSpy.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([{ id: 43, companyName: 'Acme North' }]));
    expect(await service.resolveCompanyName('Acme')).toEqual({ status: 'confirmation_required', companyName: 'Acme', candidates: [{ id: 43, companyName: 'Acme North' }], candidatesArePreview: true });
    expect(body(1)).toEqual({ filter: [{ op: 'contains', field: 'companyName', value: 'Acme' }], MaxRecords: 5, IncludeFields: ['id', 'companyName'] });
  });
  test('partial candidates are bounded previews even when more matches exist', async () => {
    const candidates = Array.from({ length: 5 }, (_, id) => ({ id, companyName: `Acme ${id}` }));
    fetchSpy.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page(candidates, '/Companies/query/next?paging=more'));
    expect(await service.resolveCompanyName('Acme')).toMatchObject({ status: 'confirmation_required', candidatesArePreview: true, candidates });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  test('zero exact and partial matches is not_found', async () => {
    fetchSpy.mockImplementation(async () => page([]));
    expect(await service.resolveCompanyName('Acme')).toMatchObject({ status: 'not_found', candidates: [] });
  });
  test.each([{ items: [company] }, { items: [company], pageDetails: {} }, { items: null, pageDetails: { nextPageUrl: null } }, { items: [company], pageDetails: { nextPageUrl: 42 } }])('malformed metadata fails closed: %j', async response => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow('invalid pagination');
  });
  test.each([{ id: -1, companyName: 'Acme' }, { id: 1.5, companyName: 'Acme' }, { companyName: 'Acme' }, { id: 42, companyName: 'Other' }, { id: 42 }])('invalid or mismatched company row fails closed: %j', async row => {
    fetchSpy.mockResolvedValue(page([row]));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow('company lookup');
  });
  test('repeated cursors fail without guessing', async () => {
    fetchSpy.mockImplementation(async () => page([], '/Companies/query/next?paging=repeat'));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow('repeated pagination');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  test('pagination never sends credentials outside the tenant zone', async () => {
    fetchSpy.mockResolvedValue(page([company], 'https://other.invalid/Companies/query/next?paging=second'));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow('outside the tenant zone');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  test('non-progressing pagination has a five-page budget', async () => {
    let cursor = 0;
    fetchSpy.mockImplementation(async () => page([], `/Companies/query/next?paging=${++cursor}`));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow('budget exceeded');
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
  test('a pagination API failure cannot become a resolved first-page company', async () => {
    fetchSpy.mockResolvedValueOnce(page([company], '/Companies/query/next?paging=second'))
      .mockResolvedValueOnce(new Response('Vendor outage', { status: 503 }));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow('503');
  });
  test.each([401, 403, 429, 500])('vendor HTTP %s remains an error', async status => {
    fetchSpy.mockResolvedValue(new Response('Vendor failure', { status, headers: { 'retry-after': '60' } }));
    await expect(service.resolveCompanyName('Acme')).rejects.toThrow(String(status));
  });
  test.each(['', ' '.repeat(3), 'A'.repeat(251)])('invalid company name rejects before I/O', async name => {
    await expect(service.resolveCompanyName(name)).rejects.toThrow('Company name');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ticket company intent routing', () => {
  let service: AutotaskService;
  let handler: AutotaskToolHandler;
  let resolve: jest.SpiedFunction<AutotaskService['resolveCompanyName']>;
  const route = async (intent: string) => {
    const result = await handler.callTool('autotask_router', { intent });
    expect(result.isError).not.toBe(true);
    return JSON.parse(result.content[0].text).data;
  };
  beforeEach(() => {
    service = new AutotaskService(config, logger);
    resolve = jest.spyOn(service, 'resolveCompanyName').mockResolvedValue({ status: 'resolved', companyID: 42 });
    handler = new AutotaskToolHandler(service, logger, true);
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['find tickets for Acme Corp', 'Acme Corp'], ['tickets at Acme, Inc.', 'Acme, Inc.'],
    ["tickets from O'Brien & Sons", "O'Brien & Sons"], ['tickets for A.C.M.E.', 'A.C.M.E.'],
    ['tickets for "Acme, Inc." today', 'Acme, Inc.'], ["tickets for 'O'Brien Corp' last week", "O'Brien Corp"],
    ['tickets "Acme Corp"', 'Acme Corp'], ['tickets for company Acme Corp', 'Acme Corp'],
    ['tickets at Acme last week', 'Acme'], ['tickets for Acme completed last week', 'Acme'],
    ['tickets last week for Acme', 'Acme'], ['tickets at Acme in the last seven days', 'Acme'],
    ['find tickets for Acme 123', 'Acme 123'], ['find tickets for "Company 123"', 'Company 123'],
    ['tickets for Open Systems', 'Open Systems'], ['tickets for New Era', 'New Era'],
    ['tickets for Close Brothers', 'Close Brothers'], ['tickets for Notes Inc.', 'Notes Inc.'],
    ['tickets for "Last Week LLC"', 'Last Week LLC'], ['tickets for "123"', '123'],
  ])('%s resolves %s as a company, never a ticket number', async (intent, name) => {
    const result = await route(intent);
    expect(result.suggestedTool).toBe('autotask_search_tickets');
    expect(result.suggestedParams).toEqual({ companyID: 42 });
    expect(result.requiredParams).toEqual([]);
    expect(resolve).toHaveBeenCalledWith(name);
  });
  test.each(['tickets today', 'tickets for today', 'tickets from last week', 'open tickets', 'new tickets'])('%s never looks up date/status words as a company', async intent => {
    expect((await route(intent)).suggestedParams).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(['tickets for 0', 'show tickets for company 0', 'tickets companyID: 0', 'tickets for company ID 0'])('%s preserves explicit companyID zero', async intent => {
    expect((await route(intent)).suggestedParams).toEqual({ companyID: 0 });
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(['tickets for', 'tickets for company', 'tickets for ""', 'tickets for Acme or Beta', 'tickets for "Acme" and "Beta"', 'tickets for company -1', 'tickets for company 1.5', 'tickets for company 9007199254740992', 'tickets for Acme companyID 9'])('%s requires clarification without I/O', async intent => {
    const result = await route(intent);
    expect(result.requiredParams).toEqual(['companyID']);
    expect(result.suggestedParams).toEqual({});
    expect(result.clarification.field).toBe('companyID');
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(['WYRE', 'Summit'])('%s has no hardcoded root-company mapping', async name => {
    await route(`tickets for ${name}`);
    expect(resolve).toHaveBeenCalledWith(name);
  });
  test.each(['not_found', 'ambiguous', 'confirmation_required'] as const)('%s returns structured clarification', async status => {
    resolve.mockResolvedValue({ status, companyName: 'Acme', candidates: [], candidatesArePreview: true });
    const result = await route('tickets for Acme');
    expect(result.suggestedParams).toEqual({});
    expect(result.requiredParams).toEqual(['companyID']);
    expect(result.clarification).toMatchObject({ field: 'companyID', reason: status, companyName: 'Acme', candidatesArePreview: true });
  });
  test('resolved root company remains zero', async () => {
    resolve.mockResolvedValue({ status: 'resolved', companyID: 0 });
    expect((await route('tickets for Acme')).suggestedParams).toEqual({ companyID: 0 });
  });
  test('a ticket prefix and an independently named company retain both scopes', async () => {
    expect((await route('tickets T20261003 at Acme')).suggestedParams).toEqual({ searchTerm: 'T20261003', companyID: 42 });
  });
  test.each(['search tickets for T20261003', 'find tickets for "t20261003"', 'tickets T20261003.00 last week'])('%s preserves a ticket-number prefix', async intent => {
    const result = await route(intent);
    expect(result.suggestedTool).toBe('autotask_search_tickets');
    expect(result.suggestedParams.searchTerm).toMatch(/^T20261003(?:\.00)?$/);
    expect(result.suggestedParams).not.toHaveProperty('companyID');
    expect(result.requiredParams).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(['Find ticket T20200101.0001 from last week', 'tickets for "T20200101.0001" today'])('%s preserves exact number precedence', async intent => {
    expect((await route(intent)).suggestedParams).toEqual({ ticketNumber: 'T20200101.0001', fullDetails: true });
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(['get ticket 12345 last week', 'show ticket #12345', 'find ticket ID: 12345', 'get ticket 12345.', 'get issue 12345'])('%s preserves exact numeric ID behavior', async intent => {
    expect((await route(intent)).suggestedParams).toEqual({ ticketID: 12345, fullDetails: true });
    expect(resolve).not.toHaveBeenCalled();
  });
  test('ticket-like tokens inside a quoted company name are not identifiers', async () => {
    expect((await route('find tickets for "Acme T20261003.0001"')).suggestedParams).toEqual({ companyID: 42 });
  });
  test('vendor failures retain the existing error envelope', async () => {
    resolve.mockRejectedValue(new Error('HTTP 401: vendor authorization failed'));
    const result = await handler.callTool('autotask_router', { intent: 'tickets for Acme' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'HTTP 401: vendor authorization failed', tool: 'autotask_router' });
  });
  test('rate limiting retains its typed envelope and retry guidance', async () => {
    resolve.mockRejectedValue(new AutotaskRateLimitError('HTTP 429', 60));
    const result = await handler.callTool('autotask_router', { intent: 'tickets for Acme' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error_type: 'rate_limited', retry_after_seconds: 60, tool: 'autotask_router' });
  });
  test('meta-tool dispatch waits for company resolution', async () => {
    const result = await handler.callTool('autotask_execute_tool', { toolName: 'autotask_router', arguments: { intent: 'tickets for Acme' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).data.suggestedParams).toEqual({ companyID: 42 });
  });
});

describe('company zero and existing search restrictions', () => {
  afterEach(() => jest.restoreAllMocks());
  test('zero is an actual company filter, with existing open/status/queue/date defaults', async () => {
    const service = new AutotaskService(config, logger);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page([{ id: 1 }]));
    await service.searchTickets({ companyID: 0, queueID: 7, createdAfter: '2026-10-01' });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.filter).toEqual(expect.arrayContaining([
      { op: 'eq', field: 'companyID', value: 0 }, { op: 'noteq', field: 'status', value: 5 },
      { op: 'eq', field: 'queueID', value: 7 }, { op: 'gte', field: 'createDate', value: '2026-10-01' },
    ]));
  });
  test.each(['companyID', 'companyId', 'CompanyID'])('zero survives %s without date elicitation', async key => {
    const service = new AutotaskService(config, logger);
    const search = jest.spyOn(service, 'searchTickets').mockResolvedValue([]);
    const handler = new AutotaskToolHandler(service, logger);
    const elicitInput = jest.fn();
    handler.setServer({ elicitInput } as unknown as Parameters<typeof handler.setServer>[0]);
    await handler.callTool('autotask_search_tickets', { [key]: 0 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ companyId: 0 }));
    expect(elicitInput).not.toHaveBeenCalled();
  });
  test('company resolution adds no inferred date field, range, or timezone', async () => {
    const result = await buildTicketSearchRoute('tickets for Acme completed last week', async () => ({ status: 'resolved', companyID: 42 }));
    expect(result.suggestedParams).toEqual({ companyID: 42 });
  });
});
