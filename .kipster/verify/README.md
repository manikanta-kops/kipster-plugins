# Verifying the plugin server

The instance runs `npm run instance`: the fixture service on `{port2}` and the
plugin server on `{port}`, in one process. Both bind `127.0.0.1`. Everything is
test data; nothing leaves loopback.

## The instance

- **URL**: the origin of the readiness URL, for example `http://127.0.0.1:8790`.
  `GET /health` needs no token.
- **Bearer token**: `kipster-verify-token-not-secret`, a fixed, non-secret test
  value. The control API (`/v1`) and the MCP endpoint (`/mcp`) need it.
- **Catalogue**: a copy of `test/fixtures/catalogue/` at
  `/tmp/kipster-plugins-verify-<port>/catalogue`, watched live. It holds one
  plugin, `fixture`, with `whoami` reviewed as read and `create_note`
  unreviewed (write).
- **Home**: `.local/verify/home` in the instance checkout, with the file key
  backend. Each start wipes the home and the catalogue copy.
- The plugin server sends every service request to the fixture service; DCR is
  on. CIMD is covered by the level 1 tests, not this instance.

## Test users

The fixture service has `alice` (`alice@fixture.test`) and `bob`
(`bob@fixture.test`). Consent needs no person: the fixture's authorize URL
completes immediately with `&user=alice`, `&user=bob` or `&user=deny`; the
redirect then goes to the plugin server's `/callback`, as a browser would.

## Driving it

Run commands from the repository root. Each command needs `URL` and `TOKEN` in
the same shell invocation, so start every command with:

```sh
export URL=http://127.0.0.1:<port> TOKEN=kipster-verify-token-not-secret;
```

- `curl` for the control API, for example
  `curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins"`.
- `npm run --silent mcp -- --url "$URL" --token "$TOKEN" list`, `call <tool>
'<json>'` or `watch --seconds 20` for the MCP endpoint. Add `--era modern` to
  use the 2026-07-28 protocol revision instead of the 2025 session.
- `sh .kipster/verify/sign-in.sh <alice|bob|deny> [plugin]` signs in through
  the control API and the fixture consent, then prints the sign-in status.
- `sh .kipster/verify/account-id.sh <label>` prints an account's id.
- `sh .kipster/verify/add-plugin.sh <id> <Name>` adds a copy of the fixture
  plugin to the instance catalogue.

[The control API](../../docs/control-api.md) documents every route and result.

## Evidence

This server has no screen. Save command output to `$EVIDENCE_DIR`, for example
`... > "$EVIDENCE_DIR/tools-list.json"`, and quote the relevant lines in the
report. Server diagnostics such as invalid catalogue edits appear in the
instance's start log.

## State reset

`sh .kipster/verify/reset.sh` removes every account (revoking it at the
fixture) and restores the catalogue copy. Notes written to the fixture remain
until the instance restarts. Reset before each feature map.

## Feature maps

- [Sign-in](features/sign-in.md): DCR sign-in, duplicates, declined consent,
  the token and Host checks.
- [Accounts](features/accounts.md): list, rename, default, remove.
- [Tools](features/tools.md): labels, the `account` argument and calls.
- [Discovery](features/discovery.md): `plugin_list` and `plugin_get`.
- [Catalogue reload](features/catalogue-reload.md): add, break and remove a
  plugin without a restart.
