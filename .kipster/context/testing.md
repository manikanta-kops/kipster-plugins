# Testing without real accounts

The project cannot hold an account for every service, and factory agents never
sign in to real services. Every change is proven at the levels below. A plan
names the level that proves each acceptance criterion. A report says which
levels ran, and which did not.

## Level 1: fixture service (deterministic, in `npm run check`)

A local fixture service stands in for a real class A service. It runs inside
the tests on a free loopback port, with no network access. It has:

- an OAuth authorization server with PKCE (S256), dynamic client registration
  (DCR) and client ID metadata documents (CIMD), authorization codes, refresh
  token rotation and revocation;
- protected resource metadata and authorization server metadata at the paths
  the MCP authorization specification defines;
- a consent step that tests can complete without a person, and at least two
  users, so tests can sign in several accounts;
- an MCP server, built with the official MCP SDK, with one read tool that
  reports the signed-in user and one write tool.

Level 1 covers the whole shared mechanism, end to end:

- sign-in through DCR and through CIMD;
- several accounts in one plugin, duplicate detection by stable ID, labels;
- the `account` argument and every step of account resolution, including the
  "ambiguous" result;
- tool listing, `<plugin>__<tool>` naming, read and write labels, and
  unreviewed tools counted as write;
- refresh under a per-account lock, rotation, revocation and "reconnect
  needed";
- catalogue loading and live reload without a restart;
- the discovery tools `plugin_list` and `plugin_get`.

Plugin configurations themselves are validated by schema in `npm run check`:
required fields, an `https` MCP URL, a known sign-in method, unique names, and
the special cases (the person's own address, SSE transport).

The first task that adds the plugin server also adds this fixture service.
Until then, `npm run check` only checks formatting and runs any tests that
exist.

## Level 2: live probe (every listed service, no account)

The probe checks that every catalogue entry's MCP server is alive and still
signs in the way the catalogue says. For each entry it:

1. sends an MCP `initialize` request with no token. A `401` usually points to
   resource metadata in its `WWW-Authenticate` header. A service may instead
   answer without sign-in (2xx); the probe then looks for metadata at the
   well-known paths;
2. reads the protected resource metadata and its authorization server's
   metadata. The resource may be the endpoint itself, its origin or a path
   prefix on that origin, as the MCP SDK accepts;
3. confirms the sign-in method: a `registration_endpoint` for DCR, or
   `client_id_metadata_document_supported` for CIMD, and S256 PKCE.

Rules:

- The probe is read-only. It never registers a client, signs in or calls a
  tool. Registering on every run would leave junk clients at every vendor.
- It is polite: limited concurrency, a timeout per request and an honest user
  agent.
- Each entry gets a result: `ok`, `sign-in changed`, `unreachable` or `error`,
  with the date. Results never contain tokens.
- It depends on the network and on vendors, so it is not part of
  `npm run check`. Testers run it for every change that touches the catalogue,
  sign-in discovery or the probe, and attach the report. A scheduled CI job
  runs it later to catch vendors that move or break.
- A vendor outage is not a regression. A failure the change caused is.

## Level 3: real accounts (owner only, outside the factory)

The owner signs in with project test accounts, lists the tools and runs one
read-only action. This happens for the plugins the owner chooses, and for at
least one DCR and one CIMD service. Factory agents never do this, and never
use the owner's own accounts.

Each plugin records how far it was tested: `probe` or `account`. Plugins
without an account test ship marked "not yet tested with a real account", and
all their tools count as write until reviewed.

## Isolation

- Never read or change the owner's installed Kipster or plugin server, its
  home folder, its keychain items or its signed-in accounts.
- Tests keep all state in a temporary folder, and keep secrets in a test-only
  store, never the macOS keychain.
- Bind servers to `127.0.0.1` on free ports, never fixed ports.

## Factory instance

The kit's `verify` block runs `npm run instance`: the fixture service on
`{port2}` and the plugin server on `{port}`, with a copy of the fixture
catalogue (`test/fixtures/catalogue/`) pointing at it. Each start wipes its
home and catalogue under `.local/verify/` in the checkout. It uses the file key
backend, no database and the documented bearer token. Readiness is
`http://127.0.0.1:{port}/health`. [The verify guide](../verify/README.md) and its
feature maps for sign-in, accounts, tools, discovery and catalogue reload
explain how to drive it.

Kit changes always go to the owner for approval.
