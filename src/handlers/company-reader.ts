import type { AutotaskService } from '../services/autotask.service.js';
import type { Logger } from '../utils/logger.js';

const LABEL_WAIT_MS = 5_000;
const PICKLIST_FIELDS = ['classification', 'companyType'] as const;

/** A deliberately narrow company read; never return arbitrary vendor fields. */
export async function readCompanySummary(
  service: Pick<AutotaskService, 'getCompany' | 'getFieldInfo'>,
  logger: Logger,
  id: unknown,
): Promise<Record<string, unknown>> {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new Error('companyID is required and must be a non-negative safe integer');
  }
  const company = await service.getCompany(id);
  // The shared HTTP client may retain an explicit { item: null } envelope.
  if (company == null || company.item === null) {
    throw new Error(`No company found with companyID ${id}. Verify the ID is correct.`);
  }
  if (company.id !== id) {
    throw new Error('Company response did not contain the requested companyID');
  }
  const result: Record<string, unknown> = { id };
  if (typeof company.companyName === 'string') result.companyName = company.companyName;
  if (typeof company.isActive === 'boolean' || company.isActive === 0 || company.isActive === 1) {
    result.isActive = company.isActive;
  }
  for (const field of PICKLIST_FIELDS) {
    const value = company[field];
    if (typeof value === 'number' && Number.isSafeInteger(value)) result[field] = value;
  }
  if (!PICKLIST_FIELDS.some(field => result[field] !== undefined)) return result;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // No new cache/shared state. Each lookup uses this call's tenant-bound service.
    // This bounds the response wait only, NOT the underlying request: existing
    // HTTP timeout/retry behavior still applies after the caller stops waiting.
    const fields = await Promise.race([
      service.getFieldInfo('Companies'),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LABEL_WAIT_MS); }),
    ]);
    if (fields === null) {
      logger.debug('Company label wait expired; returning raw IDs. Metadata request may still be running.');
      return result;
    }
    const labels: Record<string, string> = {};
    for (const name of PICKLIST_FIELDS) {
      if (result[name] === undefined) continue;
      const field = fields.find(field => field.name === name && field.isPickList);
      // Inactive values still describe existing company records.
      const match = field?.picklistValues?.find(value => String(value.value) === String(result[name]));
      if (typeof match?.label === 'string' && match.label.length > 0) labels[name] = match.label;
    }
    if (Object.keys(labels).length > 0) result.picklistLabels = labels;
  } catch {
    logger.debug('Company label lookup unavailable; returning raw IDs without labels.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return result;
}
