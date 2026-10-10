import { AutotaskHttpClient, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config = { name: 'contracts', version: '0', autotask: {
  username: 'contracts-test', secret: 'synthetic', integrationCode: 'synthetic',
  apiUrl: 'https://contracts.invalid/ATServicesRest/',
} };
const base = 'https://contracts.invalid/ATServicesRest/v1.0';
const client = () => new AutotaskHttpClient('contracts-test', 'synthetic', 'synthetic', config.autotask.apiUrl, logger);
const sent = (spy: jest.SpiedFunction<typeof fetch>) => spy.mock.calls.map(([url, init]) => ({
  url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined,
}));

beforeEach(() => { _resetZoneUrlCache(); _resetRateLimitCooldowns(); });
afterEach(() => jest.restoreAllMocks());

test.each([{}, { status: 1, assignedResourceID: 42 }])('unassigned filter uses notExist and keeps status precedence: %j', async options => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] })));
  await new AutotaskService(config, logger).searchTickets({ ...options, unassigned: true });
  expect(sent(spy)).toEqual([{ url: `${base}/Tickets/query`, method: 'POST', body: {
    MaxRecords: 25, filter: [
      'status' in options ? { op: 'eq', field: 'status', value: 1 } : { op: 'noteq', field: 'status', value: 5 },
      { op: 'notExist', field: 'assignedResourceID' },
    ],
  } }]);
});

test.each([['approved', 'exist'], ['unapproved', 'notExist']])('time approval %s sends a valid existence operator', async (approvalStatus, op) => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] })));
  await new AutotaskService(config, logger).searchTimeEntries({ ticketId: 7, approvalStatus } as any);
  expect(sent(spy)).toEqual([{ url: `${base}/TimeEntries/query`, method: 'POST', body: {
    MaxRecords: 25, filter: [{ op: 'eq', field: 'ticketID', value: 7 }, { op, field: 'billingApprovalDateTime' }],
  } }]);
});

test('PATCH target id wins over body id without mutating the caller', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
  const body = { id: 99, title: 'changed' };
  await client().update('Tickets', 7, body);
  expect(sent(spy)).toEqual([{ url: `${base}/Tickets`, method: 'PATCH', body: { id: 7, title: 'changed' } }]);
  expect(body.id).toBe(99);
});

test('child PATCH also keeps the explicit target id', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
  await client().childUpdate('Companies', 0, 'Contacts', 7, { id: 99, firstName: 'Jane' });
  expect(sent(spy)).toEqual([{ url: `${base}/Companies/0/Contacts`, method: 'PATCH', body: { id: 7, firstName: 'Jane' } }]);
});

test('partial ticket updates never turn a PATCH 404 into PUT', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing route', { status: 404 }));
  await expect(new AutotaskService(config, logger).updateTicket(7, { title: 'changed' })).rejects.toThrow('HTTP 404');
  expect(sent(spy)).toEqual([{ url: `${base}/Tickets`, method: 'PATCH', body: { id: 7, title: 'changed' } }]);
});

test('explicit replacement opt-in allows PUT only after a numeric 404 and preserves the target', async () => {
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('missing route', { status: 404 }))
    .mockResolvedValueOnce(new Response(''));
  await client().update('Tickets', 7, { id: 99, title: 'replacement' }, { putFallback: true });
  expect(sent(spy)).toEqual([
    { url: `${base}/Tickets`, method: 'PATCH', body: { id: 7, title: 'replacement' } },
    { url: `${base}/Tickets/7`, method: 'PUT', body: { id: 7, title: 'replacement' } },
  ]);
});

test.each([400, 403, 405, 422, 500])('opt-in does not retry status %i even if the error mentions 404', async status => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('field reference 404', { status }));
  await expect(client().update('Tickets', 7, { title: 'changed' }, { putFallback: true })).rejects.toThrow(`HTTP ${status}`);
  expect(spy).toHaveBeenCalledTimes(1);
});

test.each([false, true])('ticket assignment keeps an explicit resource role, lazy=%s', async lazy => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
  const service = new AutotaskService(config, logger);
  const roles = jest.spyOn(service, 'resolveRoleForResource');
  const handler = new AutotaskToolHandler(service, logger, true);
  const args = { ticketId: 7, assignedResourceID: 42, assignedResourceRoleID: 501 };
  const result = await handler.callTool(lazy ? 'autotask_execute_tool' : 'autotask_update_ticket',
    lazy ? { toolName: 'autotask_update_ticket', arguments: args } : args);
  expect(result.isError).not.toBe(true);
  expect(sent(spy)).toEqual([{ url: `${base}/Tickets`, method: 'PATCH', body: {
    id: 7, assignedResourceID: 42, assignedResourceRoleID: 501,
  } }]);
  expect(roles).not.toHaveBeenCalled();
});

test('ticket assignment fills only an omitted role', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
  const service = new AutotaskService(config, logger);
  jest.spyOn(service, 'resolveRoleForResource').mockResolvedValue(502);
  const result = await new AutotaskToolHandler(service, logger, true)
    .callTool('autotask_update_ticket', { ticketId: 7, assignedResourceID: 42 });
  expect(result.isError).not.toBe(true);
  expect(sent(spy)[0]?.body).toEqual({ id: 7, assignedResourceID: 42, assignedResourceRoleID: 502 });
});
