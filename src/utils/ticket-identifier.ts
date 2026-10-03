// A date-only ticket prefix remains a broad search. Explicit ticketNumber
// lookup also accepts the compact legacy form, without adding date filters.
const TICKET_NUMBER = /^T\d{8}(?:\.\d{4,})?$/i;
const FULL_TICKET_NUMBER = /^T\d{8}\.\d{4,}$/i;

export function normalizeTicketNumber(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length > 32 || !TICKET_NUMBER.test(value.trim())) {
    throw new Error('Provide an exact ticket number, for example T20261003.0001.');
  }
  return value.trim().toUpperCase();
}

export function isFullTicketNumber(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length <= 32 && FULL_TICKET_NUMBER.test(value.trim());
}

export function requirePositiveId(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}
