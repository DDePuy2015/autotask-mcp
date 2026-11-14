import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { FieldInfo } from '../src/services/picklist.cache';

const logger = new Logger('error');
const summary = { id: 0, companyName: 'Synthetic company', isActive: false, classification: 0, companyType: 2 };
const company = { ...summary, address1: 'PRIVATE', phone: 'PRIVATE', ownerResourceID: 7,
  notes: 'PRIVATE', userDefinedFields: [{ name: 'private', value: 'PRIVATE' }],
  _enhanced: { companyName: 'PRIVATE' }, picklistLabels: { private: 'PRIVATE' } };
const fields = [
  { name: 'classification', isPickList: true, picklistValues: [{ value: '0', label: 'Inactive tier', isActive: false }] },
  { name: 'companyType', isPickList: true, picklistValues: [{ value: '2', label: 'Customer', isActive: true }] },
  { name: 'ownerResourceID', isPickList: true, picklistValues: [{ value: '7', label: 'PRIVATE' }] },
] as FieldInfo[];
const labels = { classification: 'Inactive tier', companyType: 'Customer' };
function fixture(row: any = company) {
  const service = { getCompany: jest.fn().mockResolvedValue(row), getFieldInfo: jest.fn().mockResolvedValue(fields) };
  const handler = new AutotaskToolHandler(service as unknown as AutotaskService, logger);
  return { service, handler };
}
function payload(result: any) { return JSON.parse(result.content[0].text); }
const modes = ['direct', 'nested'] as const;
function call(handler: AutotaskToolHandler, mode: typeof modes[number], args: any) {
  return mode === 'direct' ? handler.callTool('autotask_get_company', args)
    : handler.callTool('autotask_execute_tool', { toolName: 'autotask_get_company', arguments: args });
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe.each(modes)('%s company reads', mode => {
  test.each(['companyID', 'companyId', 'CompanyID'])('accepts %s including company zero with a narrow envelope', async key => {
    const { handler, service } = fixture();
    const before = JSON.stringify(company);
    const result = await call(handler, mode, { [key]: 0 });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toEqual({ message: 'Company 0 retrieved successfully', data: { ...summary, picklistLabels: labels } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(company)).toBe(before);
    expect(service.getCompany).toHaveBeenCalledWith(0);
    expect(service.getFieldInfo).toHaveBeenCalledWith('Companies');
  });
  test.each([
    {}, { companyID: undefined }, { companyID: null }, { companyID: -1 }, { companyID: 1.5 },
    { companyID: '0' }, { companyID: NaN }, { companyID: Infinity }, { companyID: true },
    { companyID: Number.MAX_SAFE_INTEGER + 1 }, { companyID: [] }, { companyID: {} },
  ])('rejects invalid IDs before HTTP: %j', async args => {
    const { handler, service } = fixture();
    const result = await call(handler, mode, args);
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/non-negative safe integer/);
    expect(service.getCompany).not.toHaveBeenCalled();
    expect(service.getFieldInfo).not.toHaveBeenCalled();
  });
  test('keeps established canonical then lower-case then upper-case precedence', async () => {
    const { handler, service } = fixture();
    for (const args of [{ companyID: 0, companyId: 9, CompanyID: 8 }, { companyId: 0, CompanyID: 8 }]) {
      expect((await call(handler, mode, args)).isError).not.toBe(true);
      expect(service.getCompany).toHaveBeenLastCalledWith(0);
    }
    expect((await call(handler, mode, { companyID: null, companyId: 0 })).isError).toBe(true);
    expect(service.getCompany).toHaveBeenCalledTimes(2);
  });
  test.each([null, undefined, { item: null }])('missing company %j is an explicit error', async row => {
    const { handler, service } = fixture(null);
    service.getCompany.mockResolvedValue(row);
    const result = await call(handler, mode, { companyID: 0 });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe('No company found with companyID 0. Verify the ID is correct.');
    expect(service.getFieldInfo).not.toHaveBeenCalled();
  });
  test('rejects a mismatched response identity', async () => {
    const { handler, service } = fixture({ ...company, id: 9 });
    expect((await call(handler, mode, { companyID: 0 })).isError).toBe(true);
    expect(service.getFieldInfo).not.toHaveBeenCalled();
  });
});

describe('best-effort company labels', () => {
  test.each([{ metadata: [] }, { metadata: [{ name: 'classification', isPickList: true, picklistValues: [{ value: '99', label: 'Other' }] }] }])('keeps raw IDs if metadata cannot resolve them', async ({ metadata }) => {
    const { handler, service } = fixture();
    service.getFieldInfo.mockResolvedValue(metadata);
    expect(payload(await call(handler, 'direct', { companyID: 0 })).data).toEqual(summary);
  });
  test('metadata failures and empty results are retried on the next call, without shared cache', async () => {
    const { handler, service } = fixture();
    service.getFieldInfo.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
    for (let i = 0; i < 2; i++) expect(payload(await call(handler, 'direct', { companyID: 0 })).data).toEqual(summary);
    expect(payload(await call(handler, 'direct', { companyID: 0 })).data.picklistLabels).toEqual(labels);
    expect(service.getFieldInfo).toHaveBeenCalledTimes(3);
  });
  test('does not fetch labels when raw IDs are absent, and excludes nested values', async () => {
    const { handler, service } = fixture({ id: 0, companyName: { secret: 'PRIVATE' }, isActive: { secret: 'PRIVATE' }, classification: null, companyType: { secret: 'PRIVATE' } });
    expect(payload(await call(handler, 'direct', { companyID: 0 })).data).toEqual({ id: 0 });
    expect(service.getFieldInfo).not.toHaveBeenCalled();
  });
  test.each(['resolve', 'reject'])('returns after five seconds and safely handles late %s without mutating output', async completion => {
    jest.useFakeTimers();
    const { handler, service } = fixture();
    let resolve!: (value: FieldInfo[]) => void;
    let reject!: (reason: Error) => void;
    service.getFieldInfo.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const pending = call(handler, 'direct', { companyID: 0 });
    await jest.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(payload(result).data).toEqual(summary);
    if (completion === 'resolve') resolve(fields); else reject(new Error('late failure'));
    await Promise.resolve();
    expect(payload(result).data).toEqual(summary);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('isolates concurrent tenant label lookups', async () => {
    const first = fixture(), second = fixture();
    second.service.getFieldInfo.mockResolvedValue([{ ...fields[0], picklistValues: [{ value: '0', label: 'Other tenant' }] }]);
    const [a, b] = await Promise.all([call(first.handler, 'direct', { companyID: 0 }), call(second.handler, 'direct', { companyID: 0 })]);
    expect(payload(a).data.picklistLabels.classification).toBe('Inactive tier');
    expect(payload(b).data.picklistLabels.classification).toBe('Other tenant');
  });
});

describe('service HTTP and catalog contracts', () => {
  const config = { name: 'test', version: '0', autotask: { username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic', apiUrl: 'https://company.invalid/ATServicesRest/' } };
  test('uses GET Companies/0 and the existing metadata endpoint only', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(options?.method).toBe('GET');
      const path = String(url);
      if (path.endsWith('/Companies/0')) return new Response(JSON.stringify({ item: company }));
      if (path.endsWith('/Companies/entityInformation/fields')) return new Response(JSON.stringify({ fields }));
      throw new Error(`Unexpected request: ${path}`);
    });
    const service = new AutotaskService(config, logger);
    const handler = new AutotaskToolHandler(service, logger);
    expect(payload(await call(handler, 'direct', { companyID: 0 })).data).toEqual({ ...summary, picklistLabels: labels });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  test('HTTP 404 produces not-found and no metadata request', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));
    const result = await call(new AutotaskToolHandler(new AutotaskService(config, logger), logger), 'direct', { companyID: 0 });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/No company found/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  test('service failures remain errors instead of returning an empty success', async () => {
    const { handler, service } = fixture();
    service.getCompany.mockRejectedValue(new Error('HTTP 403 forbidden'));
    expect(payload(await call(handler, 'direct', { companyID: 0 })).error).toBe('HTTP 403 forbidden');
    expect(service.getFieldInfo).not.toHaveBeenCalled();
  });
  test('declares a read-only integer-ID tool in direct and lazy category discovery', async () => {
    const definition = TOOL_DEFINITIONS.find(tool => tool.name === 'autotask_get_company');
    expect(definition?.annotations?.readOnlyHint).toBe(true);
    expect(definition?.inputSchema).toMatchObject({ required: ['companyID'], properties: { companyID: { type: 'integer', minimum: 0 } } });
    expect(TOOL_CATEGORIES.companies.tools).toContain('autotask_get_company');
    const { handler } = fixture();
    expect((await handler.listTools()).some(tool => tool.name === 'autotask_get_company')).toBe(true);
    const lazy = new AutotaskToolHandler(fixture().service as unknown as AutotaskService, logger, true);
    const response = await lazy.callTool('autotask_list_category_tools', { category: 'companies' });
    expect(payload(response).data.some((tool: any) => tool.name === 'autotask_get_company')).toBe(true);
  });
});

