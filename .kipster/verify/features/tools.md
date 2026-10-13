# Tools

## Sub-features

- Proxied tools named `<plugin>__<tool>`, listed only for plugins with an account.
- Read and write labels in `_meta["app.kipster/access"]` and `readOnlyHint`; unreviewed tools are write.
- The `account` argument, only with two or more accounts, as an enum of labels.
- Account resolution: requested, default, only, otherwise ambiguous or unknown.
- Every result names its account; reconnect-needed after the service revokes.

## How to get to it (user point of view)

Kipster connects to `/mcp` with the bearer token and passes the tools to kips.
Drive it with the MCP CLI, in the 2025 session era by default or with
`--era modern`.

## Driving it

| User action                       | Exact command                                                                                                                                                                                                                                                      | Observable result                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| List tools with no account        | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" list`                                                                                                                                                                                                       | Only `plugin_list` and `plugin_get`, both `"access":"read"`.                                                                                 |
| Sign in alice and list            | `sh .kipster/verify/sign-in.sh alice; npm run --silent mcp -- --url "$URL" --token "$TOKEN" list`                                                                                                                                                                  | Adds `fixture__whoami` (`read`, `readOnlyHint` true) and `fixture__create_note` (`write`, `readOnlyHint` false); no `accountArgument`.       |
| Call whoami with one account      | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call fixture__whoami '{}'`                                                                                                                                                                                  | `structuredContent.login` is `alice`; last text item `Account: alice@fixture.test`; `_meta["app.kipster/account"]` has alice's id and label. |
| Sign in bob and list              | `sh .kipster/verify/sign-in.sh bob; npm run --silent mcp -- --url "$URL" --token "$TOKEN" list`                                                                                                                                                                    | Both fixture tools now show `"accountArgument":{"name":"account","labels":["alice@fixture.test","bob@fixture.test"]}`.                       |
| Call without choosing an account  | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call fixture__whoami '{}'`                                                                                                                                                                                  | `"isError":true`, text naming both labels, `_meta["app.kipster/resolution"]` `{"result":"ambiguous","candidates":[...]}`.                    |
| Call as bob                       | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call fixture__whoami '{"account":"bob@fixture.test"}'`                                                                                                                                                      | `structuredContent.login` is `bob`; last text `Account: bob@fixture.test`.                                                                   |
| Call with an unknown account      | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call fixture__whoami '{"account":"carol"}'`                                                                                                                                                                 | `"isError":true`, `{"result":"unknown-account","requested":"carol","candidates":[...]}` in `_meta`.                                          |
| Use the default                   | `ID=$(sh .kipster/verify/account-id.sh bob@fixture.test); curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -d "{\"account\":\"$ID\"}" "$URL/v1/plugins/fixture/default-account"; npm run --silent mcp -- --url "$URL" --token "$TOKEN" call fixture__whoami '{}'` | The call returns `bob` and names bob.                                                                                                        |
| Write a note as alice             | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" --era modern call fixture__create_note '{"text":"hello","account":"alice@fixture.test"}'`                                                                                                                   | `structuredContent` `{"id":1,"text":"hello","owner":"alice"}` and `Account: alice@fixture.test`.                                             |
| Inspect the full tool definitions | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" list --full > "$EVIDENCE_DIR/tools-full.json"`                                                                                                                                                              | The file shows `_meta` with `app.kipster/access` and `app.kipster/plugin`, and `annotations.readOnlyHint`.                                   |
| Call an unknown tool              | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call fixture__nope '{}'`                                                                                                                                                                                    | Exit code 1 and `Unknown tool: fixture__nope` on stderr.                                                                                     |

## Gotchas

Prefix every command with the `export URL=... TOKEN=...;` line from
`verify/README.md`, and reset first. The fixture keeps notes per user until
the instance restarts, so a note's `id` grows across runs. Refresh rotation and
reconnect-needed after revocation need fixture controls that only the tests
have; `test/server.test.ts` proves them.
