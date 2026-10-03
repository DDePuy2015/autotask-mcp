# Exact ticket lookup and native attachment images

This local change starts from Summit fork main `e575ddfdc27513aa809fb38282fab6108561babe`. It does not change deployment, credentials, ingress, proxy permissions or dependencies.

## Ticket identity

`autotask_get_ticket_details` takes exactly one of `ticketID` (positive safe integer) or `ticketNumber` (exact `TYYYYMMDD.NNNN`, with compact legacy numbers accepted explicitly). Numeric lookup uses `/Tickets/{id}`. Number lookup sends one `eq` filter on `ticketNumber`, with a two-row cap to detect ambiguity. Neither path adds status, date, queue or company exclusions. Missing, mismatched and ambiguous responses fail safely.

A complete dotted ticket number in `autotask_search_tickets.searchTerm` now uses equality and includes all statuses by default. A partial date prefix retains `beginsWith` and the existing completed-ticket exclusion. Explicit search filters remain effective. The intent router prefers exact dotted identity over date wording for read requests; no relative-date feature is introduced here.

## Attachment content

Metadata-only requests use child routes and strip unexpected binary content. Content requests verify the returned attachment ID and parent identity. Ticket-note image requests also require `ticketId` and verify both parent ticket and note. Unverified ownership returns no content.

Supported images return text metadata followed by a native MCP `{type: "image", data, mimeType}` block. The image bytes are absent from the JSON text metadata. Non-image files retain their base64 download contract. PNG, JPEG and static WebP are supported; animated PNG/WebP and other image types fail safely. No codec dependency is introduced.

Native image limits are fixed: 512 KiB decoded, 8192 pixels per edge, and 16 megapixels. Raising `maxInlineBase64Bytes` cannot raise these limits. Canonical base64, file signature, declared MIME and bounded format dimensions are checked before output. Header/chunk validation does not decompress or fully validate compressed pixel streams; a corrupt stream can still fail in the client's decoder. Service-level omissions remain metadata with `dataOmittedReason`.

## Summit proxy compatibility (read-only review)

The current proxy forwards MCP content arrays and its JSON redactor preserves canonical image base64 and `mimeType`. Its default 8 MiB response bound exceeds this fixed image limit. The backend token check remains required before MCP dispatch.

Two companion limitations require a separate proxy review:

- Default policy registers ticket-level attachment tools but omits ticket-note attachment tools. They need explicit authorization/catalog entries before note images are available through that proxy.
- Jumpstart projects ticket-details arguments to numeric `ticketID` only. Full-number `searchTerm` lookup works with its existing schema; direct details by `ticketNumber` needs a companion projection/normalization change. Standard technician requests do not apply that projection.

No proxy source or access policy is changed by this feature branch. Live Autotask and client rendering are not exercised by local synthetic tests.

## Upstream date intent review

The matching upstream proposal is [WYRE-AI/autotask-mcp PR 305](https://github.com/WYRE-AI/autotask-mcp/pull/305), open and unmerged when reviewed at head `61beefdfbc03894cd19a52d01665cb2793a062a9`. It extracts “today” as UTC `YYYY-MM-DD` and adds only `createdAfter`. It has no end bound, user-timezone handling, DST handling, or “last week” range. It adds asynchronous company resolution and hard-coded WYRE company-zero aliases. Those assumptions must not be imported into Summit unchanged. A future date feature should define timezone, half-open ranges and week boundaries, keep exact identifier precedence, and use verified tenant company data.

[PR 251](https://github.com/WYRE-AI/autotask-mcp/pull/251) is closed and unmerged. Its exact-number regex also classifies an undotted date prefix as exact while its added prefix test expects `beginsWith`. This branch independently separates complete dotted search numbers from date prefixes. Neither upstream PR is cherry-picked.

## Review and rollout boundary

Draft PR scope: **Support exact ticket lookup and bounded native attachment images**. Scope is the identifier/service/handler/schema changes, focused tests and this documentation. Draft publication and GitHub CI validation were explicitly authorized on 2026-10-03. Build, full source tests, lint and existing release controls must pass before this change is described as validated or considered for merge. Merge, image publication and deployment remain separate actions. No new credential is required by these features; production continues to use the established proxy-to-provider backend token.

## Local validation checkpoint — 2026-10-03

- Passed: 15 dependency-free source checks, including TypeScript syntax parsing, real PNG/JPEG/WebP fixtures, byte/dimension limits, unsupported and animated image rejection, ownership failures, the actual proxy redactor, and the existing backend-token validator.
- Passed: all 22 existing release-control regressions. No release workflow was dispatched.
- Failed to start: strict TypeScript check (restored compiler payload was truncated), focused Jest tests (`ts-jest` preset unavailable), and lint (ESLint executable unavailable). These are tooling failures, not passing code checks.
- Not run: full Jest suite, authenticated provider HTTP feature tests, full proxy routing/authentication end-to-end tests, live Autotask, and client image rendering. The focused Jest/HTTP test files are present for a complete dependency environment.

The initial offline restore was stopped. A public-only restore into an isolated validation directory made progress, with successful archive requests taking roughly 400 seconds each, but remained incomplete and was stopped at the declared 03:20 UTC cutoff. The private legacy `autotask-node` development package is absent from all local caches; protected npm configuration and private package credentials were not read or used. No installer remains running. Authorized draft-PR CI uses the existing repository installation mechanism. This branch is not locally validated by build, Jest or lint.
