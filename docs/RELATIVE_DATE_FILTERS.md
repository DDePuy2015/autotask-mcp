# Relative ticket date filters

`autotask_search_tickets` accepts a structured `relativeDateRange`. The model
maps a request such as "tickets created today" to the parameters below; the
server does not parse natural-language dates or infer dates from ticket numbers.
The same schema is available through progressive tool discovery.

```json
{
  "companyID": 42,
  "relativeDateRange": {
    "range": "today",
    "field": "created",
    "timeZone": "America/New_York"
  }
}
```

Both `range` and `field` are required. Each request resolves the server clock
once. Every range uses an inclusive start and exclusive end, with UTC timestamps
sent as `gte` and `lt` on the selected Autotask field. An event exactly at the end
belongs to the next period, without subtracting a millisecond or double counting.

## Calendar semantics

| Range | Local-calendar interval |
| --- | --- |
| `today` | Today's midnight through tomorrow's midnight |
| `last7days` | Midnight six dates before today through tomorrow's midnight: seven calendar dates **including today** |
| `lastweek` | The previous complete calendar week; by default, previous Monday midnight through current Monday midnight |

`last7days` includes the whole current date. It is neither a rolling 168 hours
ending at the current instant nor the seven complete dates before today.
`lastweek` excludes every date in the current calendar week, including today.
On Sunday with the default Monday week start, it still selects the earlier
complete Monday-Sunday week. These semantics remain the same across midnight,
month/year boundaries, leap years and DST.

Dates are determined in the selected IANA timezone, never the host's local
timezone. The two local boundaries are converted separately to UTC; a day can
span 23 or 25 hours. If midnight repeats, its first occurrence is used. If
midnight does not exist, the boundary is the first valid instant of that date;
a completely skipped date advances to the next valid date. Node/Worker Intl
timezone data supplies the historical offsets.

At `2026-10-03T16:00:00Z`, using America/New_York and Monday week start:

| Request | Structured range/field | UTC start inclusive | UTC end exclusive |
| --- | --- | --- | --- |
| Tickets created today | `today` / `created` | `2026-10-03T04:00:00.000Z` | `2026-10-04T04:00:00.000Z` |
| Tickets completed last week | `lastweek` / `completed` | `2026-09-21T04:00:00.000Z` | `2026-09-28T04:00:00.000Z` |
| Tickets last updated in the last seven days | `last7days` / `lastUpdated` | `2026-09-27T04:00:00.000Z` | `2026-10-04T04:00:00.000Z` |

## Choose the date field explicitly

| Field | Autotask property | Meaning |
| --- | --- | --- |
| `created` | `createDate` | Ticket creation timestamp |
| `completed` | `completedDate` | Recorded completion timestamp |
| `lastUpdated` | `lastTrackedModificationDateTime` | Tracked field/UDF changes; excludes changes solely to activity/customer-notification/customer-visible-activity timestamps |

A completion-date search without `status` includes every current status: it
does not add the existing `status != 5` default that would exclude completed
tickets. An explicit status always wins. Broad created/last-updated searches retain
the existing open-ticket default. Completion timestamp and current status are
different concepts; a reopened ticket can still have a completion timestamp.
Use the instance's status picklist when a particular current status is required.

## Configuration and validation

Deployment defaults are `America/New_York` and Monday, and contain no user or
tenant identity. Configure Node environment variables or Worker variables:

```text
AUTOTASK_DATE_TIMEZONE=America/New_York
AUTOTASK_WEEK_STARTS_ON=1
```

`AUTOTASK_WEEK_STARTS_ON` accepts `0` (Sunday) through `6` (Saturday).
Programmatic `McpServerConfig.dateRanges` / MCP arguments use
`{ "timeZone": "UTC", "weekStartsOn": 0 }`. These defaults also pass into
each isolated HTTP gateway request service. A relative request can override
`timeZone`, and `lastweek` can override `weekStartsOn`; week start is rejected
for other ranges. Defaults do not change explicit-date interpretation.

Unknown nested properties, unsupported ranges/fields, malformed objects,
invalid IANA timezones (including fixed-offset strings), and invalid week
starts return clear errors before any Autotask request. The server validates
these even when a caller bypasses schema validation.

`relativeDateRange` cannot be combined with `createdAfter`, `createdBefore`,
or `lastActivityAfter`. Legacy explicit inputs still pass through unchanged:
`createdAfter` remains `gte`, `createdBefore` remains **inclusive** `lte`, and
`lastActivityAfter` still filters `lastActivityDate`. Supplying no relative
range adds no date filter. An exact ticket ID/number lookup must use the
dedicated detail lookup and remains independent of date defaults or elicitation.
A full ticket number supplied as `searchTerm` also retains exact equality and
all-status behavior; explicit search filters, including a requested relative
range, are still honored. Router intents containing an exact identifier retain
lookup precedence even if they also contain date words.
The existing zero-filter date prompt now uses bounded relative ranges for
Today, Last 7 Calendar Days, and Previous Calendar Week; its month/quarter
explicit lower bounds remain unchanged.

## Evidence and verification

The official [Tickets contract](https://ww1.autotask.net/help/DeveloperHelp/Content/APIs/REST/Entities/TicketsEntity.htm)
lists `createDate`, `completedDate`, and `lastTrackedModificationDateTime` as
datetime properties and describes tracked-modification exclusions. The
[query contract](https://ww1.autotask.net/help/DeveloperHelp/Content/APIs/REST/API_Calls/REST_Basic_Query_Calls.htm)
supports `gte`/`lt` filter operators, while the
[timestamp contract](https://ww1.autotask.net/help/DeveloperHelp/Content/APIs/REST/API_Calls/REST_API_Calls.htm)
specifies UTC timestamps. ISO strings include `Z` consistently with the
repository's existing UTC query conventions.

Upstream [PR #305](https://github.com/WYRE-AI/autotask-mcp/pull/305) was inspected
as context: its UTC `createdAfter` for "today" does not supply a timezone-aware
upper bound. No company-alias or natural-language parsing code was copied.

`AutotaskService` accepts an optional third constructor argument `() => Date`
for deterministic tests; it defaults to the system clock. Tests assert actual
outgoing query bodies, all three field mappings, status handling, conflict
rejection before fetch, legacy inputs and exact-ID lookup independence.
Boundary tests cover DST in both directions, repeated/skipped midnight,
fractional-hour offsets, a skipped calendar date, leap day, New York midnight,
year boundaries, and configurable week starts.

Validation changes no Autotask data, runtime permissions, credentials, proxy
policies or deployment. Existing result/page-size behavior is unchanged.
