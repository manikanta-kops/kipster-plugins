# Control API and MCP endpoint

The plugin server listens on `127.0.0.1` only. One HTTP server answers:

| Path        | Token | Purpose                                                    |
| ----------- | ----- | ---------------------------------------------------------- |
| `/health`   | no    | `{ status: "ok", version, controlApiVersions: ["v1"] }`    |
| `/callback` | no    | Sign-in return address, visited by the person's browser    |
| `/v1/...`   | yes   | Control API: plugins, sign-in and accounts (JSON)          |
| `/mcp`      | yes   | MCP endpoint: every plugin's tools and the discovery tools |

Requests must send `Authorization: Bearer <token>`; otherwise `401`. The token
is `KIPSTER_PLUGINS_TOKEN` when set (at least 16 characters), else 256 random
bits stored once in `<home>/token` (`0600`). It is never read from the command
line and is compared in constant time. Every route, `/health` and `/callback`
included, refuses a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`
with `403`, against DNS rebinding. Token-protected routes also refuse a
non-loopback `Origin`.

## Control API v1

JSON in and out. Changes are additive only: new fields, routes and
`capabilities` flags; nothing is renamed or removed. Errors are
`{ "error": { "code", "message" } }`. No response holds a token, client secret
or other secret value.

| Method and path                           | Body                    | Result                                                                         |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `GET /v1`                                 |                         | `{ version: "v1", server: { name, version }, capabilities }`                   |
| `GET /v1/plugins`                         |                         | `{ plugins: [summary] }`                                                       |
| `GET /v1/plugins/{id}`                    |                         | `{ plugin: summary + accounts }`                                               |
| `POST /v1/plugins/{id}/sign-in`           | `{ address? }`          | Sign-in start result                                                           |
| `GET /v1/sign-ins/{id}`                   |                         | `pending`, `completed` (with `account`, `duplicate`) or `failed` (with `code`) |
| `PUT /v1/plugins/{id}/default-account`    | `{ account: id\|null }` | `{ plugin, defaultAccount }`                                                   |
| `DELETE /v1/plugins/{id}/default-account` |                         | Clears the default                                                             |
| `GET /v1/accounts[?plugin={id}]`          |                         | `{ accounts: [account] }`                                                      |
| `GET /v1/accounts/{id}`                   |                         | `{ account }`                                                                  |
| `PATCH /v1/accounts/{id}`                 | `{ label }`             | `{ account }` with the new label                                               |
| `DELETE /v1/accounts/{id}`                |                         | `{ removed: true, revoked }`; revokes at the service                           |

Capabilities in v1: `plugins`, `sign-in`, `accounts`, `mcp`.

A plugin **summary** has `id`, `name`, `description`, `category`, `website`,
`signIn`, `available` and `unavailableReason`, `probe` (or `null`),
`verification` (`probe`, `account` or `null`), `needsAddress`,
`addressPrompt` and `accountCount`. An **account** has `id`, `plugin`, `label`,
`issuer`, `identityVerified`, `identitySource`, `status` (`working` or
`reconnect-needed`), `isDefault`, `serverUrl`, `createdAt` and `updatedAt`.

Signing in returns `{ status: "redirect", id, method, authorizationUrl,
serverUrl, expiresAt }`: open `authorizationUrl` in the person's browser, which
comes back to `/callback`; then read `GET /v1/sign-ins/{id}`. A CIMD-only
service without `KIPSTER_PLUGINS_CLIENT_METADATA_URL` returns
`{ status: "needs-client-metadata-document" }`. Signing in to a known account
again is a `duplicate` and reconnects it. See
[sign-in and accounts](sign-in-and-accounts.md).

| Status | Codes                                                 |
| ------ | ----------------------------------------------------- |
| 400    | `invalid-request`, `invalid-label`, `invalid-address` |
| 401    | `unauthorized`                                        |
| 403    | `forbidden-host`, `forbidden-origin`                  |
| 404    | `not-found`, `unknown-plugin`, `unknown-sign-in`      |
| 405    | `method-not-allowed`                                  |
| 409    | `plugin-unavailable`                                  |
| 413    | `too-large`                                           |
| 422    | `no-sign-in-method`                                   |
| 500    | `internal`                                            |
| 502    | `failed` (sign-in discovery or start failed)          |

## MCP endpoint

`/mcp` serves the 2026-07-28 protocol revision per request, with change
notifications through `subscriptions/listen`, and 2025-era clients through a
session (`Mcp-Session-Id`) with an event stream. Both receive
`notifications/tools/list_changed` when the tool set changes: a catalogue
change, or an account added, reconnected, renamed, removed or changing status.
Every `tools/list` reflects the current state.

**Proxied tools.** For each available catalogue plugin with an account, the
server lists the service's tools with one working account (the default, else
the first working one) and exposes each as `<plugin>__<tool>`. Names outside
`^[A-Za-z0-9_-]{1,64}$` are skipped and reported by `plugin_get`. A service
that fails or takes longer than 10 seconds is left out of the list, never
fatal; failures are retried after 30 seconds. Listings are cached until the
plugin or its accounts change.

**Labels.** `_meta["app.kipster/access"]` is `read` or `write` from the plugin's
reviewed `tools`; unreviewed tools are `write`. `annotations.readOnlyHint`
matches the label; the service's own hints are dropped as untrusted.
`_meta["app.kipster/plugin"]` names the plugin.

**The `account` argument** appears only when the plugin has two or more
accounts: a string enum of their labels. When the service's tool declares its
own `account` argument, that argument is passed through untouched and ours is
`kipster_account` instead (a tool declaring both is skipped). A call resolves
the requested account, else the default, else the only one. `ambiguous`,
`unknown-account`, `no-account` and `reconnect-needed` return a tool result
with `isError: true`, a message listing the candidate labels, and the details
in `_meta["app.kipster/resolution"]`. On a `401` from the service the token is
refreshed once and the request retried.

**Every result names the account:** `_meta["app.kipster/account"]` is
`{ id, label }`, and a last text item reads `Account: <label>`.

**Discovery tools**, labelled read:

- `plugin_list` lists plugins with at least one account and their accounts
  (`id`, `label`, `status`, `default`). `include_unconnected: true` adds every
  other catalogue plugin.
- `plugin_get` takes `plugin` (an id) and returns its availability, probe,
  verification, accounts, skills (folders under `skills/` with a `SKILL.md`),
  tools with their labels (`toolsSource: "service"` from the live listing, or
  `"reviewed"` from the plugin's `tools` when not connected) and
  `skippedTools`.

Service connections use HTTPS only, follow redirects only by the rule in
[sign-in](sign-in-and-accounts.md#sign-in) and carry no credentials in URLs. They stay open for streams, and close when their account
is removed, reconnected or changes status, or when the plugin changes.
