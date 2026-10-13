# State, secrets, sign-in and accounts

These modules hold what the plugin server knows about the person's accounts.
The `serve` command, control API and MCP endpoint wire them together; this page
describes the programmatic API they use.

## Home folder and state

`openHome(dir, { keyBackend })` in `src/state/home.ts` creates the folder
(`0700`) and opens `state.db` (`0600`) with Node's built-in `node:sqlite`. The
folder is always passed explicitly; nothing defaults to a real home. Migrations
are an append-only list applied in order through `PRAGMA user_version`; a
database from a newer server is refused.

`loadSettings(env)` in `src/state/settings.ts` reads
`KIPSTER_PLUGINS_CLIENT_METADATA_URL`: unset by default, otherwise an HTTPS URL
with a path and no credentials or fragment. `returnAddress(port)` is
`http://127.0.0.1:<port>/callback`. `clientMetadataDocument(url)` returns the
JSON to publish at that URL. It lists `http://127.0.0.1/callback`, so CIMD
works only where the service matches loopback redirect URIs on any port, as
RFC 8252 requires; services without that need DCR.

## Secret store

`SecretStore` (`get`, `set`, `delete`) stores strings encrypted with
AES-256-GCM in the `secrets` table. Each row is a version byte, IV, tag and
ciphertext, with the secret's name as authenticated data. Values never appear
in errors or results. The key comes from a `KeyBackend`:

| Backend              | Use                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FileKeyBackend`     | Tests and development: `fileKeyBackend(home)` keeps the key in `secret.key` (`0600`) inside the home.                                                                                                |
| `KeychainKeyBackend` | macOS: a generic password (service `app.kipster.plugins`, account `secret-store-key`) read with `security find-generic-password` and created through `security -i` on standard input, never in argv. |

The keychain backend takes an injectable command runner; tests use a fake and
never touch the real keychain. Stored secrets are `account:<id>` (client and
tokens) and `client:<plugin>:<issuer>:<return address>` (reused DCR
registrations).

## Sign-in

`SignInManager` in `src/signin/signin.ts` uses the MCP SDK's OAuth client
(`@modelcontextprotocol/client` 2.x): discovery, DCR or CIMD, PKCE S256, the
code exchange and RFC 9207 issuer checks.

```ts
const signIn = new SignInManager({ accounts, secrets, settings, port })
const started = await signIn.start(plugin, { address })
// { status: 'redirect', id, method, authorizationUrl, serverUrl, expiresAt }
// or { status: 'needs-client-metadata-document' }
const { account, duplicate } = await signIn.complete(callbackUrl)
signIn.status(id) // pending, completed, failed (with code) or unknown
signIn.callbackHandler() // node:http handler for GET /callback
```

- DCR is used whenever the service offers it. CIMD is used for CIMD-only
  services when the client metadata URL is set; otherwise the result is
  `needs-client-metadata-document`. Services without S256, DCR or CIMD fail with
  `no-sign-in-method`.
- `needsAddress` plugins require `address`: the placeholder value (`acme` for
  `https://{domain}.aha.io/...`, `ha.example.com:8123` for a host template) or
  an HTTPS URL whose host is used; the URL may repeat the template's path but
  not add another. Results must be HTTPS without credentials.
- The `state` value is 256 random bits. Pending sign-ins are single use and
  expire after ten minutes (`expired`). Declined consent fails with `denied`.
- When the plugin already has an account and the service advertises
  `select_account` in `prompt_values_supported`, the URL asks for its account
  picker.
- Every request goes through `guardedFetch`: HTTPS without credentials, no
  redirects, 15-second timeout. Tests pass `testOnlyBaseUrl`, an HTTP
  `127.0.0.1` origin that replaces the plugin URL's origin and that requests
  cannot leave. Committed plugins stay HTTPS-only.

## Accounts

`Accounts` in `src/accounts/accounts.ts` keeps several accounts per plugin,
keyed by plugin, authorization server issuer and a stable subject.

- **Identity.** After sign-in the subject comes, in order, from an OpenID
  `id_token` `sub` (issuer and audience checked; it arrives directly from the
  token endpoint), the authorization server's `userinfo_endpoint`, then the
  plugin's optional `identity` tool (see [the plugin format](plugin-format.md)),
  which must be reviewed as `read`. OpenID subjects and tool ids are stored in
  separate namespaces. With none, the account is kept as a new one with
  `identityVerified: false`. A source that fails falls through to the next, so
  a temporary failure can create a second account.
- **Duplicates.** Signing in to a known subject replaces its tokens, keeps its
  label, sets it `working` and returns `duplicate: true`.
- **Labels** default to the email or login, else the plugin name, made unique
  per plugin with a number. `rename(id, label)` takes 1 to 64 characters,
  unique per plugin ignoring case.
- **Default.** `setDefault(plugin, id | undefined)`; one per plugin.
- **Remove.** `remove(id)` revokes the refresh and access tokens at the
  service's `revocation_endpoint` (best effort), then deletes the account and
  its secrets.
- **Tokens.** `accessToken(id)` returns a usable token, refreshing one minute
  before expiry. `refresh(id, stale?)` forces a refresh, for example after a
  `401`. Refresh, reconnect and removal run under a per-account lock in the
  server process, so concurrent callers share one request, the rotated refresh
  token is stored, and a reconnect or removal waits for a refresh in flight.
  `invalid_grant`, `invalid_client`, `unauthorized_client` or missing tokens
  set the status `reconnect-needed` until the account signs in again; other
  failures throw `refresh-failed` and keep the status.
- **Status** is `working` or `reconnect-needed`.

### Account resolution

`resolveAccount` in `src/accounts/resolve.ts` is pure; `accounts.resolve(plugin,
input)` supplies the plugin's accounts and default. The order:

1. `requested`, by id or label ignoring case; an unknown value returns
   `unknown-account` with the candidates;
2. routing `rules` (`{ prefix, account }`) matched against `target`, longest
   prefix first;
3. the only account in `reachable` (ids supplied by the caller);
4. the default; when `reachable` names two or more accounts, only if the
   default is one of them;
5. the only account.

Otherwise the result is `ambiguous` with the candidate labels (the reachable
accounts when `reachable` names two or more), or `no-account` when the plugin
has none. An empty `reachable` adds no information. Successful
results name the step in `reason`.

`connectMcp(server, { token })` in `src/mcp/client.ts` opens an SDK client to a
service MCP server with an account's token.
