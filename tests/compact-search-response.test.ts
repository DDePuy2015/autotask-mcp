import { COMPACT_SEARCH_TOOLS, detectEntityType, formatCompactResponse, EntityType } from '../src/utils/response.formatter';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';

const mappings: [string, EntityType][] = [
  ['autotask_search_tickets', 'tickets'],
  ['autotask_search_companies', 'companies'],
  ['autotask_search_contacts', 'contacts'],
  ['autotask_search_projects', 'projects'],
  ['autotask_search_tasks', 'tasks'],
  ['autotask_search_resources', 'resources'],
  ['autotask_search_billing_items', 'billingItems'],
  ['autotask_search_billing_item_approval_levels', 'billingItemApprovalLevels'],
  ['autotask_search_time_entries', 'timeEntries'],
  ['autotask_search_ticket_charges', 'ticketCharges'],
];
const charge = {
  id: 71, ticketID: 42, name: 'Synthetic charge', description: 'Fixture only',
  chargeType: 1, unitQuantity: 0, unitPrice: 12.5, unitCost: 0,
  billableToAccount: false, datePurchased: '2026-01-02', productID: 9,
  billingCodeID: 8, status: 0,
};
const resource = { id: 3, firstName: 'Synthetic', lastName: 'Resource', email: 'fixture@example.invalid', isActive: false };

describe('compact search identification', () => {
  test.each(mappings)('%s maps to %s', (name, entity) => {
    expect(detectEntityType(name)).toBe(entity);
    expect(COMPACT_SEARCH_TOOLS.has(name)).toBe(true);
  });
  test('the supported compact tools remain exactly the established ten searches', () => {
    expect([...COMPACT_SEARCH_TOOLS].sort()).toEqual(mappings.map(([name]) => name).sort());
  });
  test.each([
    '', 'autotask', 'tasks', 'autotask_search_unknown', 'autotask_search_ticket_notes',
    'autotask_get_ticket_charge', 'autotask_create_ticket', 'autotask_update_task',
    'autotask_delete_ticket_charge', 'autotask_search_ticket_charges_extra',
    'prefix_autotask_search_resources', 'AUTOTASK_SEARCH_TICKETS', 'constructor', '__proto__',
  ])('does not classify unsupported name %j', name => {
    expect(detectEntityType(name)).toBeNull();
    expect(COMPACT_SEARCH_TOOLS.has(name)).toBe(false);
  });
});

describe('compact field and envelope contracts', () => {
  test('charge values survive while unrelated fields are omitted without mutating input', () => {
    const input = { ...charge, title: 'not a ticket', internalOnly: 'excluded' };
    const before = { ...input };
    expect(formatCompactResponse([input], 'ticketCharges', {})).toEqual({
      summary: { returned: 1, hasMore: false, page: 1, pageSize: 25 }, items: [charge],
    });
    expect(input).toEqual(before);
  });
  test('resources retain identity fields and exclude task-only fields', () => {
    expect(formatCompactResponse([{ ...resource, title: 'task title', projectID: 7, percentComplete: 50 }], 'resources', {}).items).toEqual([resource]);
  });
  test.each([
    ['tickets', { id: 1, ticketNumber: 'T1', title: 'Ticket', status: 1, priority: 2, companyID: 3, assignedResourceID: 4, assignedResourceRoleID: 5, createDate: '2026-01-01', dueDateTime: '2026-01-02' }],
    ['tasks', { id: 2, title: 'Task', status: 1, projectID: 3, assignedResourceID: 4, percentComplete: 0 }],
  ] as [EntityType, Record<string, unknown>][])('%s keeps its existing field selection', (entity, expected) => {
    expect(formatCompactResponse([{ ...expected, name: 'unrelated', unitCost: 99, firstName: 'unrelated' }], entity, {}).items).toEqual([expected]);
  });
  test('null/undefined omission and enhanced name inlining remain unchanged', () => {
    expect(formatCompactResponse([{
      id: 1, name: '', description: null, productID: undefined,
      _enhanced: { companyName: 'Company', assignedResourceName: 'Assignee', resourceName: 'Resource', other: 'excluded' },
    }], 'ticketCharges', {}).items).toEqual([{
      id: 1, name: '', company: 'Company', assignedTo: 'Assignee', resourceName: 'Resource',
    }]);
  });
  test('empty and full pages preserve pagination metadata', () => {
    expect(formatCompactResponse([], 'resources', {})).toEqual({
      summary: { returned: 0, hasMore: false, page: 1, pageSize: 25 }, items: [],
    });
    expect(formatCompactResponse([charge], 'ticketCharges', { page: 2, pageSize: 1 })).toEqual({
      summary: { returned: 1, hasMore: true, page: 2, pageSize: 1,
        hint: 'Use page:3 for more results, or use get_ticket_details/show commands for full data on specific items' },
      items: [charge],
    });
  });
});

describe('compact searches through the actual handler', () => {
  test.each([
    ['autotask_search_ticket_charges', 'searchTicketCharges', charge],
    ['autotask_search_resources', 'searchResources', resource],
  ] as const)('%s returns the correct compact JSON envelope', async (tool, method, row) => {
    const logger = new Logger('error');
    const service = new AutotaskService({ name: 'synthetic', version: '0', autotask: {
      username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic',
      apiUrl: 'https://example.invalid/ATServicesRest/',
    } }, logger);
    const search = jest.spyOn(service, method).mockResolvedValue([row]);
    const handler = new AutotaskToolHandler(service, logger);
    // Isolate unrelated name lookups; exercise real dispatch and compact formatting.
    jest.spyOn(handler as any, 'enhanceItems').mockImplementation(async (items: any) => items);
    try {
      const result = await handler.callTool(tool, { page: 2, pageSize: 5 });
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        summary: { returned: 1, hasMore: false, page: 2, pageSize: 5 }, items: [row],
      });
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith({ page: 2, pageSize: 5 });
    } finally {
      jest.restoreAllMocks();
    }
  });
});
