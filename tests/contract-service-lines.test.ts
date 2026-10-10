// Contract service line / billed unit tool surface tests:
// autotask_search_contract_services, autotask_search_contract_service_units,
// autotask_search_contract_service_bundles, autotask_search_contract_service_bundle_units,
// and the autotask_get_contract_recurring_lines roll-up.
//
// The periodType picklist used below is the live Services.periodType picklist
// (2 Monthly, 3 Quarterly, 4 Semi-Annual, 5 Yearly) — these are the only four
// values Autotask defines, so monthly normalization must resolve all of them
// and leave unresolvedPeriodTypes empty.

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockConfig: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'test-username',
    secret: 'test-secret',
    integrationCode: 'test-integration-code'
  }
};

const mockLogger = new Logger('error');

const findTool = (name: string) => TOOL_DEFINITIONS.find(t => t.name === name);

const NEW_TOOLS = [
  'autotask_search_contract_services',
  'autotask_search_contract_service_units',
  'autotask_search_contract_service_bundles',
  'autotask_search_contract_service_bundle_units',
  'autotask_get_contract_recurring_lines',
];

const PERIOD_TYPE_FIELD = {
  name: 'periodType',
  dataType: 'integer',
  isRequired: true,
  isReadOnly: true,
  isQueryable: true,
  isReference: false,
  isPickList: true,
  picklistValues: [
    { value: '2', label: 'Monthly' },
    { value: '3', label: 'Quarterly' },
    { value: '4', label: 'Semi-Annual' },
    { value: '5', label: 'Yearly' },
  ],
};

describe('contract service line tool definitions', () => {
  test.each(NEW_TOOLS)('%s is defined and requires contractID', (name) => {
    const tool = findTool(name);
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, any>;
    expect(props.contractID.type).toBe('number');
    expect(tool!.inputSchema.required).toEqual(['contractID']);
  });

  test.each(NEW_TOOLS)('%s is listed in the financial category', (name) => {
    expect(TOOL_CATEGORIES.financial.tools).toContain(name);
  });

  test('unit tools expose an optional activeOn date', () => {
    for (const name of ['autotask_search_contract_service_units', 'autotask_search_contract_service_bundle_units']) {
      const props = findTool(name)!.inputSchema.properties as Record<string, any>;
      expect(props.activeOn.type).toBe('string');
    }
  });

  test('all five tools are read-only — no create/update/delete verbs', () => {
    for (const name of NEW_TOOLS) {
      expect(name).not.toMatch(/_(create|update|delete)_/);
    }
  });
});

describe('contract service line handlers', () => {
  test('autotask_search_contract_services forwards contractID and pageSize', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'searchContractServices').mockResolvedValue([{ id: 1 }] as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_search_contract_services', { contractID: 29747643, pageSize: 50 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ contractID: 29747643, pageSize: 50 }));
    expect(result.isError).toBeFalsy();
  });

  test('autotask_search_contract_service_units forwards activeOn', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue([{ id: 1 }] as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    await handler.callTool('autotask_search_contract_service_units', { contractID: 7, activeOn: '2026-09-08' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ contractID: 7, activeOn: '2026-09-08' }));
  });

  test('autotask_search_contract_service_bundles and _bundle_units forward to their service methods', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const bundles = jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    const units = jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    await handler.callTool('autotask_search_contract_service_bundles', { contractID: 7 });
    await handler.callTool('autotask_search_contract_service_bundle_units', { contractID: 7, activeOn: '2026-09-08' });
    expect(bundles).toHaveBeenCalledWith(expect.objectContaining({ contractID: 7 }));
    expect(units).toHaveBeenCalledWith(expect.objectContaining({ contractID: 7, activeOn: '2026-09-08' }));
  });
});

describe('searchContractServiceUnits date filtering', () => {
  test('activeOn becomes startDate lte / endDate gte filters on the given day', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query });

    await service.searchContractServiceUnits({ contractID: 29747643, activeOn: '2026-09-08' });

    const [entity, filters] = query.mock.calls[0];
    expect(entity).toBe('ContractServiceUnits');
    expect(filters).toEqual([
      { op: 'eq', field: 'contractID', value: 29747643 },
      { op: 'lte', field: 'startDate', value: '2026-09-08T23:59:59' },
      { op: 'gte', field: 'endDate', value: '2026-09-08T00:00:00' },
    ]);
  });

  test('pageSize is capped at 500', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query });

    await service.searchContractServiceUnits({ contractID: 1, activeOn: '2026-09-08', pageSize: 5000 });

    expect(query.mock.calls[0][2]).toEqual({ maxRecords: 500 });
  });
});

describe('getContractRecurringLines roll-up', () => {
  const buildService = (overrides: Record<string, any> = {}) => {
    const service = new AutotaskService(mockConfig, mockLogger);
    jest.spyOn(service, 'getContract').mockResolvedValue({
      id: 29747643, contractName: 'AIC - Cloud Services', companyID: 29746549,
    } as any);
    jest.spyOn(service, 'getFieldInfo').mockResolvedValue([PERIOD_TYPE_FIELD] as any);
    jest.spyOn(service, 'getCompany').mockImplementation(async (id: number) => (
      id === 29746549
        ? { id, companyName: 'Advanced Industrial Coatings (AIC)' } as any
        : { id, companyName: 'Microsoft' } as any
    ));
    jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServices').mockResolvedValue(overrides.serviceLines ?? [] as any);
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue(overrides.serviceUnits ?? [] as any);
    jest.spyOn(service, 'getService').mockImplementation(async (id: number) => overrides.catalog?.[id] ?? null);
    jest.spyOn(service, 'getServiceBundle').mockResolvedValue(null as any);
    return service;
  };

  test('joins units to the catalog and reports name, vendor and monthly total', async () => {
    const service = buildService({
      serviceLines: [{ id: 900, contractID: 29747643, serviceID: 500, unitPrice: 22 }],
      serviceUnits: [{
        id: 1, contractID: 29747643, contractServiceID: 900, serviceID: 500,
        units: 11, price: 22, cost: 18, startDate: '2026-09-01', endDate: '2026-09-30',
      }],
      catalog: { 500: { id: 500, name: 'Microsoft 365 Business Premium - A|M', periodType: 2, vendorCompanyID: 111, unitPrice: 22, unitCost: 18 } },
    });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.contractName).toBe('AIC - Cloud Services');
    expect(result.companyName).toBe('Advanced Industrial Coatings (AIC)');
    expect(result.activeOn).toBe('2026-09-08');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual(expect.objectContaining({
      source: 'service',
      name: 'Microsoft 365 Business Premium - A|M',
      vendorName: 'Microsoft',
      periodLabel: 'Monthly',
      units: 11,
      unitPrice: 22,
      periodTotal: 242,
      monthlyTotal: 242,
    }));
    expect(result.monthlyTotal).toBe(242);
    expect(result.unresolvedPeriodTypes).toEqual([]);
  });

  test('normalizes every live periodType to a monthly figure with none unresolved', async () => {
    const service = buildService({
      serviceLines: [
        { id: 1, serviceID: 2, unitPrice: 120 },
        { id: 2, serviceID: 3, unitPrice: 120 },
        { id: 3, serviceID: 4, unitPrice: 120 },
        { id: 4, serviceID: 5, unitPrice: 120 },
      ],
      serviceUnits: [
        { id: 11, contractServiceID: 1, serviceID: 2, units: 1, price: 120 },
        { id: 12, contractServiceID: 2, serviceID: 3, units: 1, price: 120 },
        { id: 13, contractServiceID: 3, serviceID: 4, units: 1, price: 120 },
        { id: 14, contractServiceID: 4, serviceID: 5, units: 1, price: 120 },
      ],
      catalog: {
        2: { id: 2, name: 'Monthly svc', periodType: 2 },
        3: { id: 3, name: 'Quarterly svc', periodType: 3 },
        4: { id: 4, name: 'Semi-Annual svc', periodType: 4 },
        5: { id: 5, name: 'Yearly svc', periodType: 5 },
      },
    });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });
    const byName = Object.fromEntries(result.lines.map(l => [l.name, l.monthlyTotal]));

    expect(byName['Monthly svc']).toBe(120);
    expect(byName['Quarterly svc']).toBe(40);
    expect(byName['Semi-Annual svc']).toBe(20);
    expect(byName['Yearly svc']).toBe(10);
    expect(result.unresolvedPeriodTypes).toEqual([]);
    expect(result.monthlyTotal).toBe(190);
  });

  test('a periodType missing from the picklist is reported, not guessed silently', async () => {
    const service = buildService({
      serviceLines: [{ id: 1, serviceID: 9, unitPrice: 50 }],
      serviceUnits: [{ id: 11, contractServiceID: 1, serviceID: 9, units: 2, price: 50 }],
      catalog: { 9: { id: 9, name: 'Odd period svc', periodType: 99 } },
    });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.unresolvedPeriodTypes).toEqual([99]);
    expect(result.lines[0].periodTotal).toBe(100);
  });

  test('a contract with no active units returns an empty lines array, not an error', async () => {
    const service = buildService({ serviceLines: [], serviceUnits: [] });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.lines).toEqual([]);
    expect(result.monthlyTotal).toBe(0);
    expect(result.unresolvedPeriodTypes).toEqual([]);
  });

  test('defaults activeOn to today when omitted', async () => {
    const service = buildService({ serviceLines: [], serviceUnits: [] });

    const result = await service.getContractRecurringLines({ contractID: 29747643 });

    expect(result.activeOn).toBe(new Date().toISOString().slice(0, 10));
  });
});

// Regression tests for the price-basis fix. ContractServiceUnits.price is the
// EXTENDED line amount on our tenant, not a per-unit rate — the original
// roll-up multiplied by units a second time and reported AIC at $5,883.50/mo
// against a real ~$482.60. The numbers below are the live AIC rows
// (contract 29747643) and their catalog rates.
describe('getContractRecurringLines price basis', () => {
  const AIC_ROWS = [
    { serviceID: 45,  units: 11, price: 254.10, catalogRate: 23.10, name: 'Microsoft 365 Business Premium - A|M' },
    { serviceID: 134, units: 17, price: 63.75,  catalogRate: 3.75,  name: 'AvePoint Microsoft 365 Migration FLY (Server) M|M' },
    { serviceID: 38,  units: 4,  price: 16.80,  catalogRate: 4.20,  name: 'Exchange Online (Plan 1)  - A|M' },
    { serviceID: 57,  units: 1,  price: 9.45,   catalogRate: 9.45,  name: 'Service 57' },
    { serviceID: 33,  units: 13, price: 32.50,  catalogRate: 2.50,  name: 'DNS Security Service Licensing - Umbrella - M|M' },
    { serviceID: 78,  units: 15, price: 63.75,  catalogRate: 4.25,  name: 'Service 78' },
    { serviceID: 41,  units: 13, price: 42.25,  catalogRate: 3.25,  name: 'Service 41' },
  ];

  const aicService = () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    jest.spyOn(service, 'getContract').mockResolvedValue({
      id: 29747643, contractName: 'AIC - Cloud Services', companyID: 29746549,
    } as any);
    jest.spyOn(service, 'getFieldInfo').mockResolvedValue([PERIOD_TYPE_FIELD] as any);
    jest.spyOn(service, 'getCompany').mockResolvedValue({ id: 1, companyName: 'Advanced Industrial Coatings (AIC)' } as any);
    jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServices').mockResolvedValue(
      AIC_ROWS.map((r, i) => ({ id: 900 + i, serviceID: r.serviceID, unitPrice: r.catalogRate, invoiceDescription: '' })) as any
    );
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue(
      AIC_ROWS.map((r, i) => ({ id: i, contractServiceID: 900 + i, serviceID: r.serviceID, units: r.units, price: r.price, cost: 0 })) as any
    );
    jest.spyOn(service, 'getService').mockImplementation(async (id: number) => {
      const r = AIC_ROWS.find(x => x.serviceID === id)!;
      return { id, name: r.name.startsWith('Service ') ? '' : r.name, unitPrice: r.catalogRate, unitCost: 0, periodType: 2 } as any;
    });
    jest.spyOn(service, 'getServiceBundle').mockResolvedValue(null as any);
    return service;
  };

  test('reads price as the extended line amount and totals AIC at 482.60, not 5883.50', async () => {
    const result = await aicService().getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.monthlyTotal).toBe(482.60);
    expect(result.monthlyTotal).not.toBe(5883.50);
    expect(result.lines.every(l => l.priceBasis === 'extended')).toBe(true);
    expect(result.assumedExtendedLines).toBe(0);
  });

  test('derives the per-unit price from the extended amount', async () => {
    const result = await aicService().getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });
    const bp = result.lines.find(l => l.serviceID === 45)!;

    expect(bp.units).toBe(11);
    expect(bp.periodTotal).toBe(254.10);
    expect(bp.unitPrice).toBe(23.10);
    expect(bp.monthlyTotal).toBe(254.10);
  });

  test('a genuinely per-unit row is not doubled', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    jest.spyOn(service, 'getContract').mockResolvedValue({ id: 1, companyID: 2 } as any);
    jest.spyOn(service, 'getFieldInfo').mockResolvedValue([PERIOD_TYPE_FIELD] as any);
    jest.spyOn(service, 'getCompany').mockResolvedValue({ id: 2, companyName: 'X' } as any);
    jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServices').mockResolvedValue([{ id: 900, serviceID: 45, unitPrice: 23.10 }] as any);
    // price equals the catalog rate while units > 1 -> per-unit, so extend it.
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue([
      { id: 1, contractServiceID: 900, serviceID: 45, units: 11, price: 23.10, cost: 0 },
    ] as any);
    jest.spyOn(service, 'getService').mockResolvedValue({ id: 45, name: 'BP', unitPrice: 23.10, periodType: 2 } as any);
    jest.spyOn(service, 'getServiceBundle').mockResolvedValue(null as any);

    const result = await service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' });

    expect(result.lines[0].priceBasis).toBe('per-unit');
    expect(result.lines[0].periodTotal).toBe(254.10);
    expect(result.monthlyTotal).toBe(254.10);
  });

  test('no catalog match is flagged assumed-extended and counted', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    jest.spyOn(service, 'getContract').mockResolvedValue({ id: 1, companyID: 2 } as any);
    jest.spyOn(service, 'getFieldInfo').mockResolvedValue([PERIOD_TYPE_FIELD] as any);
    jest.spyOn(service, 'getCompany').mockResolvedValue({ id: 2, companyName: 'X' } as any);
    jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServices').mockResolvedValue([{ id: 900, serviceID: 77 }] as any);
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue([
      { id: 1, contractServiceID: 900, serviceID: 77, units: 5, price: 100, cost: 0 },
    ] as any);
    jest.spyOn(service, 'getService').mockResolvedValue(null as any);
    jest.spyOn(service, 'getServiceBundle').mockResolvedValue(null as any);

    const result = await service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' });

    expect(result.lines[0].priceBasis).toBe('assumed-extended');
    expect(result.lines[0].periodTotal).toBe(100);
    expect(result.assumedExtendedLines).toBe(1);
  });

  test('name falls through an empty catalog name and empty invoiceDescription', async () => {
    const result = await aicService().getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.lines.every(l => l.name.trim() !== '')).toBe(true);
    expect(result.lines.find(l => l.serviceID === 57)!.name).toBe('Service 57');
    expect(result.lines.find(l => l.serviceID === 45)!.name).toBe('Microsoft 365 Business Premium - A|M');
  });

  test('unitCost falls through a zero unit-row cost to the catalog rate', async () => {
    const service = aicService();
    jest.spyOn(service, 'getService').mockImplementation(async (id: number) => (
      { id, name: 'Exchange Online (Plan 1)  - A|M', unitPrice: 4.20, unitCost: 3.36, periodType: 2 } as any
    ));
    jest.spyOn(service, 'searchContractServices').mockResolvedValue([{ id: 900, serviceID: 38, unitPrice: 4.20 }] as any);
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue([
      { id: 1, contractServiceID: 900, serviceID: 38, units: 4, price: 16.80, cost: 0 },
    ] as any);

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.lines[0].unitCost).toBe(3.36);
    expect(result.lines[0].monthlyCost).toBe(13.44);
  });

  test('a rate-limit error surfaces instead of degrading into blank rows', async () => {
    const service = aicService();
    jest.spyOn(service, 'getService').mockRejectedValue(new Error('Autotask API threshold exceeded (HTTP 429)'));

    await expect(service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' }))
      .rejects.toThrow(/429/);
  });
});

// The period-label cache used to be assigned outside its try/catch, so one
// failed getFieldInfo cached an empty map for the process lifetime: every
// periodType then resolved to null, `factor ?? 1` billed yearly lines as
// monthly, and the contract total overstated by up to 12x. Flagged upstream on
// PR #284.
describe('servicePeriodLabels cache poisoning', () => {
  const svcWithPicklist = (getFieldInfo: jest.Mock) => {
    const service = new AutotaskService(mockConfig, mockLogger);
    jest.spyOn(service, 'getFieldInfo').mockImplementation(getFieldInfo as any);
    jest.spyOn(service, 'getContract').mockResolvedValue({ id: 1, companyID: 2 } as any);
    jest.spyOn(service, 'getCompany').mockResolvedValue({ id: 2, companyName: 'X' } as any);
    jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServices').mockResolvedValue([{ id: 900, serviceID: 81, unitPrice: 264 }] as any);
    // One yearly line: 1 unit, extended price 264/yr -> must normalize to 22/mo.
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue([
      { id: 1, contractServiceID: 900, serviceID: 81, units: 1, price: 264, cost: 0 },
    ] as any);
    jest.spyOn(service, 'getService').mockResolvedValue(
      { id: 81, name: 'Microsoft 365 Business Premium - A|A', unitPrice: 264, periodType: 5 } as any
    );
    jest.spyOn(service, 'getServiceBundle').mockResolvedValue(null as any);
    return service;
  };

  test('a failed picklist load is not cached, and the next call recovers', async () => {
    const getFieldInfo = jest.fn()
      .mockRejectedValueOnce(new Error('Autotask API threshold exceeded (HTTP 429)'))
      .mockResolvedValue([PERIOD_TYPE_FIELD]);
    const service = svcWithPicklist(getFieldInfo);

    await expect(service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' }))
      .rejects.toThrow(/429/);

    // Second call must retry the lookup rather than reuse a poisoned empty map.
    const result = await service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' });
    expect(getFieldInfo).toHaveBeenCalledTimes(2);
    expect(result.lines[0].periodLabel).toBe('Yearly');
    expect(result.lines[0].monthlyTotal).toBe(22);
    expect(result.monthlyTotal).toBe(22);
    expect(result.monthlyTotal).not.toBe(264);
  });

  test('an empty picklist raises instead of billing yearly lines as monthly', async () => {
    const service = svcWithPicklist(jest.fn().mockResolvedValue([{ ...PERIOD_TYPE_FIELD, picklistValues: [] }]));

    await expect(service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' }))
      .rejects.toThrow(/cannot normalize/i);
  });

  test('a successful picklist load is cached across calls', async () => {
    const getFieldInfo = jest.fn().mockResolvedValue([PERIOD_TYPE_FIELD]);
    const service = svcWithPicklist(getFieldInfo);

    await service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' });
    await service.getContractRecurringLines({ contractID: 1, activeOn: '2026-09-08' });

    expect(getFieldInfo).toHaveBeenCalledTimes(1);
  });
});
