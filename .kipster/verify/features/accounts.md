# Accounts

## Sub-features

- Listing accounts, for all plugins or one.
- Renaming a label; labels are unique per plugin, ignoring case.
- Setting and clearing a plugin's default account.
- Removing an account, which revokes it at the service.

## How to get to it (user point of view)

Kipster's account list and admin tools call the control API's
`/v1/accounts` and `/v1/plugins/{id}/default-account` routes.

## Driving it

| User action                 | Exact command                                                                                                                                                                                   | Observable result                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Sign in two accounts        | `sh .kipster/verify/sign-in.sh alice; sh .kipster/verify/sign-in.sh bob`                                                                                                                        | Two `"status":"completed"` results.                                                                               |
| List the plugin's accounts  | `curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts?plugin=fixture"`                                                                                                                  | `accounts` with `alice@fixture.test` then `bob@fixture.test`, both `working`, `isDefault` false; no token fields. |
| Count accounts per plugin   | `curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/fixture"`                                                                                                                          | `"accountCount":2` and both accounts listed.                                                                      |
| Rename bob to Work          | `ID=$(sh .kipster/verify/account-id.sh bob@fixture.test); curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"label":"Work"}' "$URL/v1/accounts/$ID"` | `{"account":{...,"label":"Work",...}}`                                                                            |
| Give alice a clashing label | `ID=$(sh .kipster/verify/account-id.sh alice@fixture.test); curl -sS -w ' %{http_code}\n' -X PATCH -H "Authorization: Bearer $TOKEN" -d '{"label":"work"}' "$URL/v1/accounts/$ID"`              | `{"error":{"code":"invalid-label","message":"Another account has this label"}} 400`                               |
| Make Work the default       | `ID=$(sh .kipster/verify/account-id.sh Work); curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -d "{\"account\":\"$ID\"}" "$URL/v1/plugins/fixture/default-account"`                           | `{"plugin":"fixture","defaultAccount":"<that id>"}`; the account list shows `"isDefault":true` for it.            |
| Clear the default           | `curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/fixture/default-account"`                                                                                                | `{"plugin":"fixture","defaultAccount":null}`                                                                      |
| Remove alice                | `ID=$(sh .kipster/verify/account-id.sh alice@fixture.test); curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts/$ID"`                                                        | `{"removed":true,"revoked":true}`; listing shows only Work.                                                       |
| Read a removed account      | `curl -sS -w ' %{http_code}\n' -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts/nope"`                                                                                                       | `{"error":{"code":"not-found",...}} 404`                                                                          |

## Gotchas

Prefix every command with the `export URL=... TOKEN=...;` line from
`verify/README.md`, and reset first. `account-id.sh` matches labels ignoring
case. Removing the last account of a plugin also removes its tools from
`tools/list` (see the tools map).
