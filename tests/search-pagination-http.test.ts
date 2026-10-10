import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskHttpClient } from '../src/services/autotask-http';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config = { name: 'pagination', version: '0', autotask: {
  username: 'pagination-test', secret: 'synthetic', integrationCode: 'synthetic',
  apiUrl: 'https://pagination.invalid/ATServicesRest/',
} };
const base = 'https://pagination.invalid/ATServicesRest/v1.0';
const client = () => new AutotaskHttpClient('pagination-test', 'synthetic', 'synthetic', config.autotask.apiUrl, logger);
const page = (items: unknown[], nextPageUrl: string | null = null) => new Response(JSON.stringify({ items, pageDetails: { nextPageUrl } }));
const searches = [
  ['Tickets', 'searchTickets', 'autotask_search_tickets', { companyID: 0 }, [{ op: 'noteq', field: 'status', value: 5 }, { op: 'eq', field: 'companyID', value: 0 }]],
  ['Contacts', 'searchContacts', 'autotask_search_contacts', { companyID: 0 }, [{ op: 'eq', field: 'companyID', value: 0 }]],
  ['Projects', 'searchProjects', 'autotask_search_projects', { companyID: 0 }, [{ op: 'eq', field: 'companyID', value: 0 }]],
  ['Resources', 'searchResources', 'autotask_search_resources', {}, [{ op: 'gte', field: 'id', value: 0 }]],
] as const;

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

test.each(searches)('%s page 2 walks POST cursors with identical filter/body and returns the next rows', async (entity, method, _tool, options, filter) => {
  const next = `${base}/${entity}/query/next?paging=opaque%2Bcursor`;
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(page([{ id: 1 }, { id: 2 }], next))
    .mockResolvedValueOnce(page([{ id: 3 }, { id: 4 }], next + '2'));
  const service = new AutotaskService(config, logger);
  const rows = await service[method]({ ...options, page: 2, pageSize: 2 });
  expect(rows.map(row => row.id)).toEqual([3, 4]);
  expect(spy.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) })))
    .toEqual([`${base}/${entity}/query`, next].map(url => ({ url, method: 'POST', body: { filter, MaxRecords: 2 } })));
});

test.each(searches)('%s page beyond exhaustion is empty and never repeats page 1', async (_entity, method) => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page([{ id: 1 }]));
  expect(await new AutotaskService(config, logger)[method]({ page: 2, pageSize: 2 })).toEqual([]);
  expect(spy).toHaveBeenCalledTimes(1);
});

test.each([0, -1, 1.5, 51, Infinity, '2'])('invalid page %j fails before outbound HTTP', async pageNumber => {
  const spy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test sentinel: invalid page reached HTTP'));
  await expect(new AutotaskService(config, logger).searchTickets({ page: pageNumber } as any)).rejects.toThrow('page must be an integer');
  expect(spy).not.toHaveBeenCalled();
});

test.each(['https://other.invalid/Tickets/query/next?paging=x', `${base}/Contacts/query/next?paging=x`, `${base}/Tickets/query/next?paging=x#fragment`])('unsafe cursor %s is refused without forwarding credentials', async cursor => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page([{ id: 1 }], cursor));
  await expect(new AutotaskService(config, logger).searchTickets({ page: 2, pageSize: 2 })).rejects.toThrow('refusing a pagination cursor');
  expect(spy).toHaveBeenCalledTimes(1);
});

test('relative next cursor retains the query and POST body', async () => {
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(page([{ id: 1 }], '/Tickets/query/next?paging=a%2Bb'))
    .mockResolvedValueOnce(page([{ id: 2 }]));
  expect((await new AutotaskService(config, logger).searchTickets({ page: 2, pageSize: 1 })).map(row => row.id)).toEqual([2]);
  expect(spy.mock.calls[1]?.[0]).toBe(`${base}/Tickets/query/next?paging=a%2Bb`);
  expect(spy.mock.calls[1]?.[1]?.body).toBe(spy.mock.calls[0]?.[1]?.body);
  expect(spy.mock.calls[1]?.[1]?.method).toBe('POST');
});

test('a repeated cursor is rejected rather than looping', async () => {
  let count = 0;
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (++count > 3) throw new Error('Test sentinel: unbounded repeated cursor');
    return page([], '/Tickets/query/next?paging=repeat');
  });
  await expect(new AutotaskService(config, logger).searchTickets({ page: 2 })).rejects.toThrow('repeated pagination cursor');
  expect(spy).toHaveBeenCalledTimes(2);
});

test('empty continuing pages cannot exhaust the request budget', async () => {
  let count = 0;
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (++count > 50) throw new Error('Test sentinel: unbounded empty pages');
    return page([], `/Tickets/query/next?paging=${count}`);
  });
  await expect(new AutotaskService(config, logger).searchTickets({ page: 2 })).rejects.toThrow('pagination budget exceeded');
  expect(spy).toHaveBeenCalledTimes(50);
});

test('maxRecords without page keeps aggregate-cap semantics', async () => {
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(page([{ id: 1 }], '/Tickets/query/next?paging=x'))
    .mockResolvedValueOnce(page([{ id: 2 }, { id: 3 }]));
  expect(await client().query('Tickets', [], { maxRecords: 3 })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).MaxRecords).toBe(3);
});

test.each(searches)('%s compact hints and schema describe working bounded continuation', async (_entity, method, tool) => {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service, method).mockResolvedValue([{ id: 1 }, { id: 2 }]);
  const handler = new AutotaskToolHandler(service, logger, true);
  const result = await handler.callTool(tool, { page: 2, pageSize: 2 });
  expect(JSON.parse(result.content[0].text).summary).toMatchObject({ page: 2, pageSize: 2, hasMore: true, hint: expect.stringContaining('page:3') });
  expect(TOOL_DEFINITIONS.find(def => def.name === tool)?.inputSchema.properties.page).toMatchObject({ type: 'integer', maximum: 50 });
  const last = await handler.callTool(tool, { page: 50, pageSize: 2 });
  expect(JSON.parse(last.content[0].text).summary).toMatchObject({ hasMore: false, hint: expect.stringContaining('Narrow') });
});

test('non-paged compact searches never recommend a page argument that is ignored', async () => {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service, 'searchTimeEntries').mockResolvedValue([{ id: 1 }]);
  const result = await new AutotaskToolHandler(service, logger, true).callTool('autotask_search_time_entries', { pageSize: 1 });
  expect(JSON.parse(result.content[0].text).summary.hint).toContain('Narrow');
  expect(JSON.parse(result.content[0].text).summary.hint).not.toContain('page:');
});

test.each(['searchCompanies', 'searchTasks'] as const)('%s retains its existing fetch-and-slice pagination', async method => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]));
  const rows = await new AutotaskService(config, logger)[method]({ page: 2, pageSize: 2 });
  expect(rows.map(row => row.id)).toEqual([3, 4]);
  expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).MaxRecords).toBe(4);
});

test('compact metadata uses the effective clamped page size', async () => {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service, 'searchContacts').mockResolvedValue(Array.from({ length: 200 }, (_, index) => ({ id: index + 1 })));
  const result = await new AutotaskToolHandler(service, logger, true).callTool('autotask_search_contacts', { pageSize: 999 });
  expect(JSON.parse(result.content[0].text).summary).toMatchObject({ pageSize: 200, hasMore: true });
});
