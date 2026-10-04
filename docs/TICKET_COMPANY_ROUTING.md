# Company names in ticket search intents

`autotask_router` suggests tools; it does not execute ticket searches. For a
ticket search, `searchTerm` is a ticket-number prefix, never a company name or
title search. The router resolves a company name to `companyID` only when an
exact-name query returns one valid company and pagination proves exhaustion.
Case and whitespace are normalized for verification; punctuation is preserved.
There are no tenant-specific aliases or assumed mappings to root company zero.

Examples:

| Intent | Suggested parameters / next step |
| --- | --- |
| `tickets for Acme` | `companyID` if there is one exact Acme company |
| `tickets at "Acme, Inc." last week` | Resolve the quoted name; supply date filters separately |
| `tickets from O'Brien & Sons` | Preserve the apostrophe and ampersand during lookup |
| `tickets for company ID 0` | `companyID: 0`, without a name lookup |
| `tickets for "123"` | Look up a company literally named 123 |
| `tickets T20261003 at Acme` | Ticket-number prefix plus resolved company scope |
| `find ticket T20261003.0001 from last week` | Existing exact-number detail lookup, without automatic dates |
| `get ticket #12345` | Existing numeric-ID detail lookup |

Unquoted phrases after `at`, `for`, or `from` stop at recognized date phrases,
including today, last week, the last seven days, and ISO calendar dates. Quote
names containing date words, conjunctions, scope words, or sentence punctuation
when the boundary would otherwise be unclear. This is a conservative grammar,
not a general natural-language parser. Arbitrary numbers elsewhere in a company
name or date phrase are not inferred as company or ticket IDs.

Before executing a suggestion, satisfy **every `requiredParams` entry** and
inspect `clarification`. An unresolved company produces `requiredParams:
["companyID"]`, omits `companyID`, and includes one of these reasons:

- `missing_company` or `ambiguous_phrase`: supply one explicit company ID or
  one quoted name. No vendor lookup is made for an unclear phrase.
- `not_found`: exact and partial queries found no matching companies.
- `ambiguous`: at least two exact-name rows were returned.
- `confirmation_required`: partial matches exist, even if the preview contains
  only one candidate. Confirm an explicit ID instead of assuming uniqueness.

Candidate lists always have `candidatesArePreview: true`. They are deliberately
bounded and are not an exhaustive list. No prefix, fuzzy match, deduplication,
active-company preference, or guessed alias can select a company automatically.
The two-row exact-query cap disproves uniqueness as soon as two rows exist;
one row is accepted only after the last page. Partial previews contain at most
five rows. Each query has a five-page budget. Missing pagination metadata,
invalid records, repeated cursors, exhausted budgets, and vendor API failures
return errors rather than claiming a missing or resolved company. HTTP 429
keeps the existing typed rate-limit envelope and retry guidance.

This change builds on the fork's existing zero-ID protection without duplicating
it: explicit and resolved `companyID: 0` remain filters and do not trigger the
zero-filter date prompt. Company searches do not silently exclude inactive
companies. Ticket search defaults, status/queue/date filters, and exact-number
all-status lookups retain their service behavior.

Date parsing and filtering remain separate. The router neither adds UTC
`createdAfter` for today nor infers a field or timezone. With the separate
[relative date draft PR #6](https://github.com/DDePuy2015/autotask-mcp/pull/6), a
caller can combine the resolved `companyID` with an explicit `relativeDateRange`
such as `{ "range": "lastweek", "field": "completed", "timeZone":
"America/New_York" }`. Exact detail lookup precedence is unchanged.

The implementation adapts the problem described in
[upstream #305](https://github.com/WYRE-AI/autotask-mcp/pull/305); it does not
copy its WYRE aliases, unique partial-match selection, or UTC today behavior.
Tool catalogs, gateway authorization, workload policies, dependencies, and
deployment settings are unchanged. A router suggestion supplies no additional
permission to execute a tool; consumers must continue enforcing their existing
access and workload restrictions.
