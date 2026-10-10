import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskRateLimitError, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const config = { name: 'parity', version: '0', autotask: {
  username: 'parity-test', secret: 'synthetic', integrationCode: 'synthetic',
  apiUrl: 'https://parity.invalid/ATServicesRest/',
} };
const base = 'https://parity.invalid/ATServicesRest/v1.0';
const logger = new Logger('error');
const service = () => new AutotaskService(config, logger);
const handler = () => new AutotaskToolHandler(service(), logger, true);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const trace = (spy: jest.SpiedFunction<typeof fetch>) => spy.mock.calls.map(([url, init]) => ({
  url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined,
}));
async function compare(tool: string, args: Record<string, unknown>) {
  const direct = await handler().callTool(tool, structuredClone(args));
  const lazy = await handler().callTool('autotask_execute_tool', { toolName: tool, arguments: structuredClone(args) });
  expect(lazy).toEqual(direct);
  return direct;
}

beforeEach(() => { _resetZoneUrlCache(); _resetRateLimitCooldowns(); });
afterEach(() => jest.restoreAllMocks());

test.each(['companyID', 'companyId', 'CompanyID'])('direct/lazy %s aliases preserve company zero and compact envelopes', async alias => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ items: [{ id: 1, firstName: 'Fixture' }] }));
  const result = await compare('autotask_search_contacts', { [alias]: 0, pageSize: 1 });
  expect(JSON.parse(result.content[0].text)).toMatchObject({ summary: { returned: 1 }, items: [{ id: 1, firstName: 'Fixture' }] });
  expect(trace(spy)).toEqual(Array(2).fill({ url: `${base}/Contacts/query`, method: 'POST', body: {
    filter: [{ op: 'eq', field: 'companyID', value: 0 }], MaxRecords: 1,
  } }));
});

test('canonical companyID wins conflicting aliases on both paths', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ items: [{ id: 1 }] }));
  await compare('autotask_search_contacts', { companyID: 0, companyId: 99, CompanyID: 98 });
  expect(trace(spy).map(call => call.body.filter)).toEqual(Array(2).fill([{ op: 'eq', field: 'companyID', value: 0 }]));
});

test('empty search and get 404 use the target tool not-found envelopes', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/query')
    ? json({ items: [] }) : json({ errors: ['not found'] }, 404));
  const empty = await compare('autotask_search_contacts', { searchTerm: 'absent' });
  const missing = await compare('autotask_get_ticket_details', { ticketID: 7 });
  expect(empty.isError).toBe(true);
  expect(missing.isError).toBe(true);
  expect(JSON.parse(missing.content[0].text).tool).toBe('autotask_get_ticket_details');
});

test('direct/lazy ticket cards perform the same real HTTP reads and keep internal defaults', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = String(url).slice(base.length);
    if (path === '/Tickets/7') return json({ item: { id: 7, ticketNumber: 'T20261010.0007', title: 'Fixture', status: 1, priority: 2 } });
    if (path === '/Tickets/entityInformation/fields') return json({ fields: [] });
    if (path === '/Tickets/7/Notes/query') return json({ items: [{ title: 'Internal', description: 'fixture note' }] });
    if (path === '/TicketNotes/entityInformation/fields') return json({ fields: [
      { name: 'noteType', isPickList: true, picklistValues: [{ value: '1', label: 'General' }] },
      { name: 'publish', isPickList: true, picklistValues: [{ value: '3', label: 'Internal only' }] },
    ] });
    throw new Error(`Unexpected route ${path}`);
  });
  const direct = await handler().callTool('autotask_get_ticket_details', { ticketID: 7 });
  const directTrace = trace(spy);
  spy.mockClear();
  const lazy = await handler().callTool('autotask_execute_tool', { toolName: 'autotask_get_ticket_details', arguments: { ticketID: 7 } });
  expect(lazy).toEqual(direct);
  expect(trace(spy)).toEqual(directTrace);
  expect(directTrace).toEqual([
    { url: `${base}/Tickets/7`, method: 'GET', body: undefined },
    { url: `${base}/Tickets/entityInformation/fields`, method: 'GET', body: undefined },
    { url: `${base}/Tickets/7/Notes/query`, method: 'POST', body: { filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 5 } },
    { url: `${base}/TicketNotes/entityInformation/fields`, method: 'GET', body: undefined },
  ]);
  expect(JSON.parse(direct.content[0].text).data._card).toMatchObject({ id: 7, noteDefaults: { noteType: 1, publish: 3 }, notes: [{ description: 'fixture note' }] });
});

test('direct/lazy native attachment results retain images outside text metadata', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=';
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ item: {
    id: 456, ticketID: 123, contentType: 'image/png', fileName: 'fixture.png', data: png,
  } }));
  const result = await compare('autotask_get_ticket_attachment', { ticketId: 123, attachmentId: 456, includeData: true });
  expect(result.content[1]).toEqual({ type: 'image', data: png, mimeType: 'image/png' });
  expect(result.content[0].text).not.toContain(png);
});

test('unknown target and recursive/invalid meta calls fail before HTTP', async () => {
  const spy = jest.spyOn(globalThis, 'fetch');
  expect((await compare('autotask_unknown', {})).isError).toBe(true);
  for (const args of [{ toolName: 'autotask_execute_tool' }, { toolName: 'autotask_search_contacts', arguments: [] }, { toolName: '' }]) {
    expect((await handler().callTool('autotask_execute_tool', args)).isError).toBe(true);
  }
  expect(spy).not.toHaveBeenCalled();
});

test('rate-limited errors retain the target tool contract', async () => {
  const source = service();
  jest.spyOn(source, 'getTicket').mockRejectedValue(new AutotaskRateLimitError('synthetic rate limit', 30));
  const tools = new AutotaskToolHandler(source, logger, true);
  const direct = await tools.callTool('autotask_get_ticket_details', { ticketID: 7 });
  const lazy = await tools.callTool('autotask_execute_tool', { toolName: 'autotask_get_ticket_details', arguments: { ticketID: 7 } });
  expect(lazy).toEqual(direct);
  expect(JSON.parse(lazy.content[0].text)).toMatchObject({ error_type: 'rate_limited', retry_after_seconds: 30, tool: 'autotask_get_ticket_details' });
});

test('schemas, handlers and category membership stay in parity with explicit meta/raw exclusions', () => {
  const names = TOOL_DEFINITIONS.map(tool => tool.name);
  expect(new Set(names).size).toBe(names.length);
  const dispatch: Map<string, unknown> = (handler() as any).getDispatchTable();
  expect(new Set([...dispatch.keys(), 'autotask_execute_tool'])).toEqual(new Set(names));
  const excluded = new Set(['autotask_list_categories', 'autotask_list_category_tools', 'autotask_execute_tool', 'autotask_router', 'autotask_raw_request']);
  const categorized = Object.values(TOOL_CATEGORIES).flatMap(category => category.tools);
  expect(new Set(categorized).size).toBe(categorized.length);
  expect(new Set(categorized)).toEqual(new Set(names.filter(name => !excluded.has(name))));
  expect(categorized).not.toContain('autotask_raw_request');
  expect(names).not.toContain('autotask_update_opportunity');
});

test.each([
  ['contacts', 'autotask_update_contact'], ['projects', 'autotask_update_project'],
  ['tickets', 'autotask_search_ticket_checklist_items'], ['tickets', 'autotask_create_ticket_checklist_item'],
  ['tickets', 'autotask_update_ticket_checklist_item'], ['tickets', 'autotask_delete_ticket_checklist_item'],
  ['financial', 'autotask_get_invoice_details'],
])('%s category discovers existing business tool %s', async (category, tool) => {
  const result = await handler().callTool('autotask_list_category_tools', { category });
  expect(JSON.parse(result.content[0].text).data.map((item: { name: string }) => item.name)).toContain(tool);
});
