// Regression tests for PR #197 (follow-up to issue #133):
// Partial updates must not use a PUT replacement. A 404/405 on the collection
// PATCH can still use the documented Companies/{companyID}/Contacts PATCH.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    // Pre-set apiUrl so baseUrl() resolves without a zone-info network round-trip.
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

interface MockResponseSpec {
  status: number;
  body?: any;
  text?: string;
}

function res(spec: MockResponseSpec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: async () =>
      spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : '',
  } as unknown as Response;
}

/**
 * Route-table fetch mock: match on method + URL pattern. Unmatched requests
 * return a distinctive 599 so a failing test names the unexpected call.
 */
function mockFetchRoutes(
  routes: Array<{ method: string; path: RegExp; response: MockResponseSpec }>
): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const match = routes.find(r => r.method === (init.method || 'GET') && r.path.test(url));
    if (!match) {
      return Promise.resolve(res({ status: 599, text: `unexpected request: ${init.method} ${url}` }));
    }
    return Promise.resolve(res(match.response));
  });
}

/** Human-readable "<METHOD> <pathname>" trace of every fetch the code made. */
function calledRoutes(fetchMock: jest.SpyInstance): string[] {
  return fetchMock.mock.calls.map(
    (c: any[]) => `${(c[1] as RequestInit).method} ${new URL(c[0] as string).pathname}`
  );
}

const HTML_404 = {
  status: 404,
  text: '<html><head><title>404 - File or directory not found.</title></head></html>',
};

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AutotaskService.updateContact() child-route fallback (PR #197)', () => {
  test('falls back to child PATCH on 404, resolving companyID via getContact without PUT', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: HTML_404 },
      { method: 'PUT', path: /\/Contacts\/12345$/, response: { status: 405, body: { errors: ["does not support http method 'PUT'"] } } },
      { method: 'GET', path: /\/Contacts\/12345$/, response: { status: 200, body: { item: { id: 12345, companyID: 777, firstName: 'Old' } } } },
      { method: 'PATCH', path: /\/Companies\/777\/Contacts$/, response: { status: 200, body: { itemId: 12345 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(service.updateContact(12345, { firstName: 'Jane' })).resolves.toBeUndefined();

    // Only PATCH, parent lookup, and child PATCH are allowed for a partial update.
    expect(calledRoutes(fetchMock)).toEqual([
      'PATCH /ATServicesRest/v1.0/Contacts',
      'GET /ATServicesRest/v1.0/Contacts/12345',
      'PATCH /ATServicesRest/v1.0/Companies/777/Contacts',
    ]);
    const childBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(childBody).toMatchObject({ id: 12345, firstName: 'Jane' });
  });

  test('skips the getContact lookup when the update payload already carries companyID', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: HTML_404 },
      { method: 'PUT', path: /\/Contacts\/12345$/, response: { status: 405, body: { errors: ["does not support http method 'PUT'"] } } },
      { method: 'PATCH', path: /\/Companies\/777\/Contacts$/, response: { status: 200, body: { itemId: 12345 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(
      service.updateContact(12345, { companyID: 777, firstName: 'Jane' } as any)
    ).resolves.toBeUndefined();

    expect(calledRoutes(fetchMock)).toEqual([
      'PATCH /ATServicesRest/v1.0/Contacts',
      'PATCH /ATServicesRest/v1.0/Companies/777/Contacts',
    ]);
  });

  test('treats companyID 0 (the root/MSP company) as a valid parent, not a missing one', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: HTML_404 },
      { method: 'PUT', path: /\/Contacts\/12345$/, response: { status: 405, body: { errors: ["does not support http method 'PUT'"] } } },
      { method: 'PATCH', path: /\/Companies\/0\/Contacts$/, response: { status: 200, body: { itemId: 12345 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(
      service.updateContact(12345, { companyID: 0, firstName: 'Jane' } as any)
    ).resolves.toBeUndefined();

    expect(calledRoutes(fetchMock)).toContain('PATCH /ATServicesRest/v1.0/Companies/0/Contacts');
  });

  test('healthy zones keep the single-request PATCH /Contacts path — no extra GET, no child route', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: { status: 200, body: { itemId: 12345 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(service.updateContact(12345, { firstName: 'Jane' })).resolves.toBeUndefined();

    expect(calledRoutes(fetchMock)).toEqual(['PATCH /ATServicesRest/v1.0/Contacts']);
  });

  test('Zone DE1 uses child PATCH even when a PUT route would succeed', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: HTML_404 },
      { method: 'PUT', path: /\/Contacts\/12345$/, response: { status: 200 } },
      { method: 'PATCH', path: /\/Companies\/777\/Contacts$/, response: { status: 200 } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(service.updateContact(12345, { companyID: 777, firstName: 'Jane' })).resolves.toBeUndefined();

    expect(calledRoutes(fetchMock)).toEqual([
      'PATCH /ATServicesRest/v1.0/Contacts',
      'PATCH /ATServicesRest/v1.0/Companies/777/Contacts',
    ]);
  });

  test('genuine validation errors (HTTP 400) surface unchanged — no fallback of any kind', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: { status: 400, body: { errors: ['Invalid field reference'] } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(service.updateContact(12345, { firstName: 'Jane' })).rejects.toThrow(/HTTP 400/);

    expect(calledRoutes(fetchMock)).toEqual(['PATCH /ATServicesRest/v1.0/Contacts']);
  });

  test('fails with a clear error when the parent companyID cannot be resolved', async () => {
    mockFetchRoutes([
      { method: 'PATCH', path: /v1\.0\/Contacts$/, response: HTML_404 },
      { method: 'PUT', path: /\/Contacts\/12345$/, response: { status: 405, body: { errors: ["does not support http method 'PUT'"] } } },
      // getContact returns null on 404 — e.g. the contact was deleted between calls.
      { method: 'GET', path: /\/Contacts\/12345$/, response: { status: 404, body: { errors: ['Not found'] } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(service.updateContact(12345, { firstName: 'Jane' })).rejects.toThrow(
      /unable to resolve parent companyID/
    );
  });
});
