import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';

const config = { name: 'connection', version: '0', autotask: {
  username: 'synthetic-connection', secret: 'synthetic', integrationCode: 'synthetic',
  apiUrl: 'https://connection.invalid/ATServicesRest/',
} };
const logger = new Logger('error');
afterEach(() => jest.restoreAllMocks());

test('connection probe exercises the production HTTP route with a one-record budget', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 0 }] })));
  expect(await new AutotaskService(config, logger).testConnection()).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  const [url, init] = spy.mock.calls[0]!;
  expect(url).toBe('https://connection.invalid/ATServicesRest/v1.0/Companies/query');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 1 });
});

test('connection probe reports an actual HTTP failure without live credentials', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('probe failed', { status: 503 }));
  expect(await new AutotaskService(config, logger).testConnection()).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);
});

test('a deep-cloned invalid config cannot poison later valid production requests', async () => {
  const invalid = structuredClone(config) as { name: string; version: string; autotask: Partial<typeof config.autotask> };
  delete invalid.autotask.username;
  await expect(new AutotaskService(invalid, logger).initialize()).rejects.toThrow('Missing required Autotask credentials');
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ item: { id: 7 } })));
  expect(await new AutotaskService(config, logger).getContact(7)).toEqual({ id: 7 });
  expect(spy.mock.calls[0]?.[0]).toBe('https://connection.invalid/ATServicesRest/v1.0/Contacts/7');
});
