import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';

const config = { name: 'error-paths', version: '0', autotask: {
  username: 'error-paths-test', secret: 'synthetic', integrationCode: 'synthetic',
  apiUrl: 'https://error-paths.invalid/ATServicesRest/',
} };
const base = 'https://error-paths.invalid/ATServicesRest/v1.0';
const logger = new Logger('error');
afterEach(() => jest.restoreAllMocks());

test.each([400, 403, 405, 422, 500])('HTTP %i mentioning HTTP 404 is an error on top-level and child get routes', async status => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ errors: ['Invalid reference HTTP 404'] }), { status }));
  const service = new AutotaskService(config, logger);
  await expect(service.getContact(7)).rejects.toThrow(`HTTP ${status}`);
  await expect(service.getTicketNote(7, 9)).rejects.toThrow(`HTTP ${status}`);
  expect(spy.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body }))).toEqual([
    { url: `${base}/Contacts/7`, method: 'GET', body: undefined },
    { url: `${base}/Tickets/7/Notes/9`, method: 'GET', body: undefined },
  ]);
});

test('only actual HTTP 404 becomes not-found on each production get route', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
  const service = new AutotaskService(config, logger);
  expect(await service.getContact(7)).toBeNull();
  expect(await service.getTicketNote(7, 9)).toBeNull();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('search/create errors prove the intended methods, paths, filters and bodies', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ errors: ['synthetic validation failure'] }), { status: 422 }));
  const service = new AutotaskService(config, logger);
  await expect(service.searchTickets({ companyID: 0 })).rejects.toThrow('HTTP 422: synthetic validation failure');
  await expect(service.createTicket({ title: 'fixture', companyID: 0 })).rejects.toThrow('HTTP 422: synthetic validation failure');
  expect(spy.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: JSON.parse(String(init?.body)) }))).toEqual([
    { url: `${base}/Tickets/query`, method: 'POST', body: { filter: [{ op: 'noteq', field: 'status', value: 5 }, { op: 'eq', field: 'companyID', value: 0 }], MaxRecords: 25 } },
    { url: `${base}/Tickets`, method: 'POST', body: { title: 'fixture', companyID: 0 } },
  ]);
});

test.each([400, 403, 405, 422, 500])('child query status %i mentioning HTTP 404 never triggers a fallback GET', async status => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ errors: ['Invalid reference HTTP 404'] }), { status })
    : new Response(JSON.stringify({ items: [{ id: 9, description: 'must not be returned' }] })));
  await expect(new AutotaskService(config, logger).searchTicketNotes(7)).rejects.toThrow(`HTTP ${status}`);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]?.[0]).toBe(`${base}/Tickets/7/Notes/query`);
  expect(spy.mock.calls[0]?.[1]?.method).toBe('POST');
});

test('actual child-query 404 retains the read-only GET fallback with no POST body', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response('', { status: 404 }) : new Response(JSON.stringify({ items: [{ id: 9 }] })));
  expect(await new AutotaskService(config, logger).searchTicketNotes(7)).toEqual([{ id: 9 }]);
  expect(spy.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }))).toEqual([
    { url: `${base}/Tickets/7/Notes/query`, method: 'POST', body: { filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 25 } },
    { url: `${base}/Tickets/7/Notes`, method: 'GET', body: undefined },
  ]);
});
