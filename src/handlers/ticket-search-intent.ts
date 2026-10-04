import type { CompanyNameResolution } from '../utils/company-resolution.js';

const TICKET_PREFIX = /^T\d{6,8}(?:\.\d*)?$/i;
const DATE_PHRASE = /\s+(?:(?:created|completed|closed|updated|last\s+updated)\s+)?(?:(?:in|during|on|since|before|after|from)\s+)?(?:the\s+)?(?:today|yesterday|tomorrow|(?:last|past|this|previous|next)\s+(?:(?:\d+|seven)\s+)?(?:days?|weeks?|months?|quarters?|years?)|\d{4}-\d{2}-\d{2})\b/i;
const NON_COMPANY = /^(?:me|us|them|all|open|closed|new|today|yesterday|tomorrow|(?:last|past|this|previous|next)\s+(?:(?:\d+|seven)\s+)?(?:days?|weeks?|months?|quarters?|years?))$/i;

type CompanyReference =
  | { kind: 'none' }
  | { kind: 'name'; name: string }
  | { kind: 'id'; id: number }
  | { kind: 'clarify'; reason?: 'missing_company' };

export interface TicketSearchRoute {
  suggestedParams: Record<string, string | number>;
  requiredParams: string[];
  clarification?: {
    field: 'companyID';
    reason: 'missing_company' | 'ambiguous_phrase' | 'not_found' | 'ambiguous' | 'confirmation_required';
    message: string;
    companyName?: string;
    candidates?: { id: number; companyName: string }[];
    candidatesArePreview?: true;
  };
}

/** Restrict exact numeric ticket lookup to an explicit ticket reference. */
export function extractTicketId(intent: string): number | undefined {
  const match = intent.match(/\b(?:tickets?|issues?|requests?)\s+(?:id\s*[:#]?\s*|#\s*)?(\d+)(?![\w-]|\.\d)/i);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Keywords inside a company name must not turn a read intent into a write. */
export function ticketOperationIntent(intent: string): string {
  return intent.split(/\b(?:at|for|from)\s+|["']/i)[0];
}

export function extractTicketSearchNumber(intent: string, full = false): string | undefined {
  const company = companyReference(intent);
  const scope = company.kind === 'name' ? intent.replace(company.name, '') : intent;
  const pattern = full
    ? /(?:^|[\s"'])(T\d{8}\.\d{4,})(?=$|[\s"',;!?]|\.(?!\d))/i
    : /(?:^|[\s"'])(T\d{6,8}(?:\.\d+)?)(?=$|[\s"',;!?]|\.(?!\d))/i;
  return scope.match(pattern)?.[1]?.toUpperCase();
}

function companyReference(intent: string): CompanyReference {
  const quotes = [...intent.matchAll(/(?:^|\s)(["'])(.*?)\1(?=\s|[.,;!?]|$)/g)];
  // A quoted ticket prefix is still a ticket prefix, never a company name.
  const companyQuotes = quotes.filter(q => !TICKET_PREFIX.test(q[2]));
  if (companyQuotes.length > 1) return { kind: 'clarify' };
  const outsideQuotes = intent.replace(/(?:^|\s)(["'])(.*?)\1(?=\s|[.,;!?]|$)/g, ' ');
  const explicitIds = [...outsideQuotes.matchAll(/\bcompany\s*(?:id\s*)?[:#]?\s*(-?\d+(?:\.\d+)?)(?![\w.-])/gi)];
  if (companyQuotes.length && explicitIds.length) return { kind: 'clarify' };
  if (companyQuotes.length === 1) {
    const name = companyQuotes[0][2].trim();
    return name ? { kind: 'name', name } : { kind: 'clarify' };
  }
  if (explicitIds.length > 1) return { kind: 'clarify' };
  if (explicitIds.length === 1) {
    const remaining = outsideQuotes.replace(explicitIds[0][0], '');
    const otherScope = remaining.match(/\b(?:at|for|from)\s+(.+)/i)?.[1]?.split(DATE_PHRASE)[0].trim();
    if (otherScope && !NON_COMPANY.test(otherScope)) return { kind: 'clarify' };
    const id = Number(explicitIds[0][1]);
    return Number.isSafeInteger(id) && id >= 0 ? { kind: 'id', id } : { kind: 'clarify' };
  }
  const phrases = [...intent.matchAll(/\b(?:at|for|from)\s+(.+)/gi)];
  if (!phrases.length) return /\b(?:at|for|from|company|client|account)\s*$/i.test(intent)
    ? { kind: 'clarify', reason: 'missing_company' } : { kind: 'none' };
  let name = phrases[0][1].split(DATE_PHRASE)[0].trim().replace(/[!?;]+$/, '').trim();
  const quotedPrefix = name.match(/^(["'])(.*?)\1$/)?.[2];
  if (quotedPrefix && TICKET_PREFIX.test(quotedPrefix)) return { kind: 'none' };
  name = name.replace(/^(?:the\s+)?(?:company|client|account)(?:\s+|$)/i, '').trim();
  if (!name) return { kind: 'clarify', reason: 'missing_company' };
  if (TICKET_PREFIX.test(name) || NON_COMPANY.test(name)) return { kind: 'none' };
  // Multiple unquoted scopes are unsafe to collapse into one company name.
  if (/\b(?:at|for|from)\s+|\s+(?:and|or)\s+|["']/i.test(name.replace(/\b\w+'\w+\b/g, ''))) {
    return { kind: 'clarify' };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(name)) {
    const id = Number(name);
    return Number.isSafeInteger(id) && id >= 0 ? { kind: 'id', id } : { kind: 'clarify' };
  }
  return { kind: 'name', name };
}

/** No date inference: callers may add PR6's structured relativeDateRange. */
export async function buildTicketSearchRoute(
  intent: string,
  resolveCompany: (name: string) => Promise<CompanyNameResolution>,
): Promise<TicketSearchRoute> {
  const route: TicketSearchRoute = { suggestedParams: {}, requiredParams: [] };
  const company = companyReference(intent);
  const prefix = extractTicketSearchNumber(intent);
  if (prefix) route.suggestedParams.searchTerm = prefix;
  if (company.kind === 'none') return route;
  if (company.kind === 'id') {
    route.suggestedParams.companyID = company.id;
    return route;
  }
  route.requiredParams = ['companyID'];
  if (company.kind === 'clarify') {
    route.clarification = { field: 'companyID', reason: company.reason ?? 'ambiguous_phrase',
      message: 'Provide one companyID or one quoted company name before searching tickets.' };
    return route;
  }
  const resolution = await resolveCompany(company.name);
  if (resolution.status === 'resolved') {
    route.suggestedParams.companyID = resolution.companyID;
    route.requiredParams = [];
    return route;
  }
  route.clarification = {
    field: 'companyID', reason: resolution.status, companyName: resolution.companyName,
    candidates: resolution.candidates, candidatesArePreview: true,
    message: resolution.status === 'not_found'
      ? 'No matching company was found. Provide a companyID or correct the company name before searching tickets.'
      : 'Confirm one companyID before searching tickets. Candidates are a preview and may omit other matches.',
  };
  return route;
}
