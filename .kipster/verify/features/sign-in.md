# Sign-in

## Sub-features

- Health without a token; `401` for the control API and MCP endpoint without one.
- `403` for a foreign `Host` header on every route.
- Sign-in through the control API with DCR, completed at `/callback`.
- A second account, a duplicate sign-in and declined consent.

## How to get to it (user point of view)

Kipster's Connect screen calls `POST /v1/plugins/{id}/sign-in`, opens the
returned `authorizationUrl` in the person's browser, and reads
`GET /v1/sign-ins/{id}` after the browser returns to `/callback`.

## Driving it

| User action                       | Exact command                                                                                              | Observable result                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Check health without a token      | `curl -sS "$URL/health"`                                                                                   | `{"status":"ok","version":"0.1.0","controlApiVersions":["v1"]}`                                                                                |
| Call the API without a token      | `curl -sS -w ' %{http_code}\n' "$URL/v1/plugins"`                                                          | `{"error":{"code":"unauthorized",...}} 401`                                                                                                    |
| Call MCP with a wrong token       | `curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Authorization: Bearer wrong-token-0000' "$URL/mcp"` | `401`                                                                                                                                          |
| Send a foreign Host header        | `curl -sS -w ' %{http_code}\n' -H 'Host: evil.example' "$URL/health"`                                      | `{"error":{"code":"forbidden-host",...}} 403`                                                                                                  |
| Start a sign-in                   | `curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/fixture/sign-in"`                     | `"status":"redirect"`, `"method":"dcr"`, an `authorizationUrl` whose `redirect_uri` is `http://127.0.0.1:<port>/callback`, and an `expiresAt`. |
| Sign in as alice                  | `sh .kipster/verify/sign-in.sh alice`                                                                      | `callback 200`, then `"status":"completed"`, `"duplicate":false` and an account labelled `alice@fixture.test` with `"status":"working"`.       |
| Sign in as bob                    | `sh .kipster/verify/sign-in.sh bob`                                                                        | `callback 200`, a second account labelled `bob@fixture.test`.                                                                                  |
| Sign in as alice again            | `sh .kipster/verify/sign-in.sh alice`                                                                      | `"duplicate":true` and the same account id as the first alice sign-in.                                                                         |
| Decline consent                   | `sh .kipster/verify/sign-in.sh deny`                                                                       | `callback 400`, then `{"id":...,"status":"failed","plugin":"fixture","code":"denied"}`.                                                        |
| Read an unknown sign-in           | `curl -sS -w ' %{http_code}\n' -H "Authorization: Bearer $TOKEN" "$URL/v1/sign-ins/nope"`                  | `{"error":{"code":"unknown-sign-in",...}} 404`                                                                                                 |
| Start a sign-in for an unknown id | `curl -sS -w ' %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/nope/sign-in"`   | `{"error":{"code":"unknown-plugin",...}} 404`                                                                                                  |

## Gotchas

Prefix every command with the `export URL=... TOKEN=...;` line from
`verify/README.md`. Run `sh .kipster/verify/reset.sh` first, or alice's first
sign-in is already a duplicate. A pending sign-in expires after ten minutes.
CIMD sign-in is proven by `test/server.test.ts`, not by this instance.
