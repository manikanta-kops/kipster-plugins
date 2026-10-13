# Fixture service

`src/fixture/service.ts` stands in for a class A service in level 1 tests (see
[testing](../.kipster/context/testing.md)). One loopback origin serves:

| Path                                        | Purpose                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/mcp`                                      | MCP server built with the official SDK; `401` with `WWW-Authenticate: Bearer resource_metadata="..."` without a valid token. |
| `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728).                                                                                      |
| `/.well-known/oauth-authorization-server`   | Authorization server metadata (RFC 8414), with S256, `prompt_values_supported` and the RFC 9207 `iss` parameter.             |
| `/register`                                 | DCR (RFC 7591); a secret is issued unless `token_endpoint_auth_method` is `none`.                                            |
| `/authorize`                                | Requires S256 PKCE. `user=alice`, `user=bob` or `user=deny` completes consent without a person; without it, a link page.     |
| `/token`                                    | Authorization code and refresh grants. Codes and refresh tokens work once; refresh rotates.                                  |
| `/revoke`, `/userinfo`                      | RFC 7009 revocation (revokes the whole grant) and OpenID userinfo.                                                           |

CIMD clients are `https://` client IDs whose document the fixture resolves
through the `clientMetadata` option; it never fetches from the network.
Loopback redirect URIs match any port. The MCP server has a read tool
`whoami` (the signed-in user) and a write tool `create_note`.

`startFixture(options)` binds `127.0.0.1` on `port` (default: a free port) and
returns `url`, `mcpUrl`, live `settings`, request `stats`, `issuedTokens()`,
`revokeUser(login)`, `notes(login)` and `close()`. Options:

| Option           | Default    | Meaning                                                                          |
| ---------------- | ---------- | -------------------------------------------------------------------------------- |
| `dcr`, `cimd`    | `true`     | Offer each client registration path; switch one off to test the other alone.     |
| `identity`       | `userinfo` | `userinfo`, `id-token` (unsigned id_token in token responses), `tool` or `none`. |
| `accessTokenTtl` | `3600`     | Access token lifetime in seconds.                                                |
| `clientMetadata` | none       | `(url) => document` for CIMD client IDs.                                         |

```sh
npm run fixture -- --port 8765
npm run fixture -- --no-dcr --client-metadata-document /tmp/client.json
```

The command prints `{"url":...,"mcpUrl":...}` and runs until interrupted. Other
flags: `--no-cimd` and `--identity <mode>`. The document file's `client_id`
names the HTTPS URL it stands for.
