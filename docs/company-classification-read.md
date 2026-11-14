# Narrow company classification read

`autotask_get_company` returns the normal `{ message, data }` JSON envelope with only `id`, `companyName`, `isActive`, `classification`, and `companyType` when present and scalar. It omits addresses, contact details, notes, owner identifiers, UDFs, and all other vendor fields. It performs no name-enrichment warm-up. The existing company resource read and company search are unchanged.

`companyID` must be a non-negative safe integer; company `0` is supported. Direct and nested calls accept legacy `companyId` and `CompanyID`. Existing precedence is preserved: the first defined value in `companyID`, `companyId`, `CompanyID` wins, even when invalid (a null canonical value cannot fall back to another alias). A missing company is an explicit error; mismatched returned IDs are rejected.

`picklistLabels` may contain only `classification` and `companyType`. Raw IDs remain available if metadata is missing, unknown, empty, fails, or takes more than five seconds. Inactive picklist values can label historical records. Each call uses its own tenant-bound service with no added metadata cache; empty/failed lookups can retry on the next call. The five-second deadline limits only the label wait after the company fetch. It does not cancel queued or in-flight metadata requests, which retain the existing HTTP timeout/retry behavior. Repeated reads can therefore cause repeated metadata requests. This is not an overall tool deadline.

## Availability and scope

The provider advertises this read-only tool directly and in its companies category; the existing nested executor can call it. Provider discovery is not Summit authorization. The current inspected Summit proxy policy has no approved entry for `autotask_get_company`; it must remain denied for Reader, Operator, Admin, and ticket-scoped Jumpstart until separately reviewed. This change does not alter proxy roles, tool visibility, redaction, auditing, tenant binding, authentication, or writes. It does not grant the executor or discovery tools proxy access.

Inspired by [WYRE-AI/autotask-mcp#352](https://github.com/WYRE-AI/autotask-mcp/pull/352), reviewed at `7a60aa8381c3fff88d9f851c7fd23d77c9ed4c07`. The Summit adaptation intentionally excludes the full-record response, shared-cache changes, AbortSignal propagation, queue/cancellation changes, and broad executor changes. It reuses the existing service's GET `/Companies/{id}` and metadata reads.

Draft #12 independently improves general lazy/direct dispatch parity and HTTP-status handling. This tool handles its own aliases and missing-company errors, so it works on current main without those changes. Preserve its projection and enrichment opt-out when integrating #12. Drafts #10, #11 and #14 are unrelated and remain independent. Live gateway policy and customer data were not queried.
