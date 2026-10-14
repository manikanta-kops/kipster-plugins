# Class A plugins

A plugin contains `plugin.json` and `mcp.json`. Optional `skills/` and
`app.kipster/` directories are supported; the importer creates neither.
The portable fields follow [Agent Plugins 1.0](https://agent-plugins.org/specification).
Local validation uses `schemas/plugin.schema.json`, `schemas/mcp.schema.json`
and the semantic checks in `src/catalogue/validate.ts`; loading never fetches schemas.

`plugin.json` declares the canonical Agent Plugins `$schema`, `name` (the id),
`description`, and `extensions["app.kipster"]`. The extension contains:

| Field                           | Meaning                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`                    | Stable id and display name. Both must be unique in a catalogue; display names are compared case-insensitively.                                                               |
| `category`, `website`           | Service category and HTTPS website.                                                                                                                                          |
| `signIn`                        | Supported methods: `dcr`, `cimd`, or both.                                                                                                                                   |
| `needsAddress`, `addressPrompt` | A templated host needs the person's address and a short prompt. Concrete URLs have no prompt.                                                                                |
| `accountTypes`, `cost`          | `personal`, `business`, `business-only`, or `unknown`; `free` or `user-paid-plan`. Research `yes` maps to personal and business; original values remain in products.         |
| `products`                      | Every covered CSV row: name, rank, category, website, original accounts/cost/sign-in, and `research` with verified, checkedOn, notes and sources.                            |
| `tools`                         | Reviewed tool names mapped to `read` or `write`. Empty by default; every unreviewed tool counts as write.                                                                    |
| `verification`                  | Absent until an `ok` probe, then `probe`; `account` is reserved for an owner-run account test. Anything below account means not yet tested with a real account.              |
| `probe`                         | Latest result, observed `signIn` array, `checkedOn` date, and a one-line reason without secrets.                                                                             |
| `identity`                      | Optional `{ tool, arguments?, id, label? }`: a tool reporting who is signed in; `id` and `label` are dotted paths into its result. It must be reviewed as `read` in `tools`. |

Ids contain lowercase letters, digits and single hyphens, with at most 32
characters, and match the folder, manifest name and MCP server key.
Reviewed `<id>__<tool>` names must fit within 64 characters.

`mcp.json` declares the canonical Agent Plugins MCP `$schema` and exactly one
`mcpServers` entry keyed by id, with `type` and `url`. Sign-in and address
settings live in the manifest extension because portable MCP entries do not
allow extra fields. URLs use HTTPS without credentials or fragments. Templates
keep their research spelling (`YOUR-...`, `your-...`, `{domain}`, `<account>`).
URLs ending in `/sse` require `type: "sse"`; others use `streamable-http`.

## Importing a batch

```sh
npm run import -- Linear Notion
npm run import -- "Adobe Illustrator" Jira
npm run import -- --output /tmp/catalogue --all
```

Names match the CSV case-insensitively. Every row sharing a URL joins the same
plugin regardless of which product is selected: Jira, Confluence, Bitbucket
and Loom become `atlassian`; Lightroom and Illustrator become `adobe-creative`;
Acrobat remains separate. Other ids come from the first row's name.
Discovery observations in notes take precedence over `sign_in`.
Each source row keeps its original research; grouped cost is paid if any
product requires a paid plan.

Existing valid folders are kept byte-for-byte, with a clear message. This
makes re-import idempotent and preserves hand edits, tool reviews and probe
results. `--force` explicitly replaces both files, including those edits.
Unknown names report near matches and fail before any import. Invalid files
or filesystem errors also fail rather than leave a misleading success.
Generated JSON is formatted with the repository's Prettier settings.
Batch tasks commit only their assigned plugin folders, then probe those ids.

## Read-only probe

```sh
npm run probe -- linear notion
npm run probe -- --report /tmp/probe.md
```

No ids means every plugin. The probe only sends an unauthenticated MCP
initialize POST (SSE: GET) and discovery GETs. It never registers a client,
signs in or calls tools. Discovery follows the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):
`resource_metadata` from the 401 header, or endpoint-specific then root protected
resource well-known paths; RFC 8414 authorization metadata, then both OpenID
forms for path issuers. It inspects the first advertised authorization server,
checks resource/issuer identity, and requires S256. A service may answer the
anonymous initialize with 2xx and still offer OAuth; the probe then uses the
well-known paths, never reads the body and applies the same checks. Like the MCP
SDK sign-in, it accepts a resource on the endpoint's origin whose path is a
prefix of the endpoint path, such as the origin itself.

| Result                           | Meaning                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                             | 401 (or anonymous 2xx), recorded methods and S256 confirmed. Sets verification to probe.                                                                             |
| `sign-in-changed`                | Methods differ, or S256 is absent. Review the observed methods before updating signIn; original research remains intact.                                             |
| `needs-address`                  | Template URL; sends nothing. Available, because connecting will ask for the address.                                                                                 |
| `needs-client-metadata-document` | CIMD only, with matching recorded methods, and the probe ran without a client metadata document URL. It uses Kipster's unless `--client-metadata-url` names another. |
| `unreachable`                    | Connection, DNS, TLS, timeout or HTTP 5xx after three attempts.                                                                                                      |
| `error`                          | Unexpected HTTP response, missing/invalid metadata (also after anonymous 2xx), identity mismatch or unsafe discovery URL.                                            |

Availability is derived: unprobed, `ok` and `needs-address` entries are available;
all other probe results stay in the catalogue, unavailable with their reason.
A failed later probe clears `probe` verification, but preserves an earlier
`account` verification. Availability still follows the latest probe.

Each request has a 10-second timeout including its body, with up to three
attempts for connection failures and HTTP 5xx, and 100/200 ms backoff. Permanent
HTTP or malformed-document failures are not retried. At most four services run
at once. Redirects follow the server's rule (see
[sign-in](sign-in-and-accounts.md#sign-in)): the initialize request stands in
for the signed-in connection and follows only same-origin 307 and 308;
discovery GETs follow any redirect to HTTPS. Resource and issuer checks still
use the configured URL and the advertised issuer, and a followed redirect is
named in the reason, such as `(endpoint redirects to /mcp/)`. JSON bodies are
bounded, and vendor body text is never copied into reasons. Reports name the
probe and repository in its User-Agent. Service failures finish with exit 0;
invalid catalogue files, unknown ids, invalid settings or probe bugs exit
nonzero.

Tests use an explicit `testOnlyBaseUrl` option (CLI: `--test-only-base-url`) to
replace endpoint origins with an HTTP `127.0.0.1` stub. Discovery cannot leave
that origin. Production files remain HTTPS-only. The live probe is separate
from `npm run check` and CI; no account testing is performed by the factory.

## Catalogue module

`Catalogue` in `src/catalogue/loader.ts` exposes a copied `plugins` map, emits
`change` snapshots and `invalid` diagnostics, and has `start`, `reload` and
`close` methods. Directory watches are debounced; invalid updates keep the last
good folder version, additions and removals need no restart. A one-second
reconciliation scan recovers missed filesystem notifications (configurable through
the constructor). Invalid initial
entries are reported and omitted. `requireCatalogue` is the strict variant for
validation, import and probe commands.
