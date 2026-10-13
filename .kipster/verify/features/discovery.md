# Discovery

## Sub-features

- `plugin_list`: connected plugins and their accounts, optionally every catalogue plugin.
- `plugin_get`: one plugin's availability, probe, verification, accounts, skills and tool labels.

## How to get to it (user point of view)

A kip calls the discovery tools through Kipster like any other tool; drive them
with the MCP CLI.

## Driving it

| User action                      | Exact command                                                                                                                                         | Observable result                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| List connected plugins with none | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_list '{}'`                                                                         | `structuredContent` `{"plugins":[]}`.                                                                                                                 |
| Include unconnected plugins      | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_list '{"include_unconnected":true}'`                                               | One plugin `fixture`, `"available":true`, `"connected":false`, `"accounts":[]`.                                                                       |
| Get the plugin before connecting | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_get '{"plugin":"fixture"}'`                                                        | `"toolsSource":"reviewed"`, `tools` `[{"name":"fixture__whoami","access":"read"}]`, `"probe":null`, `"verification":null`, `"skills":[]`.             |
| Connect two accounts and list    | `sh .kipster/verify/sign-in.sh alice; sh .kipster/verify/sign-in.sh bob; npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_list '{}'` | `fixture` with `"connected":true` and accounts alice and bob, each with `id`, `label`, `"status":"working"` and `default`.                            |
| Get the connected plugin         | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_get '{"plugin":"fixture"}' > "$EVIDENCE_DIR/plugin-get.json"`                      | `"toolsSource":"service"`, `fixture__whoami` read, `fixture__create_note` write, `"skippedTools":[]`, `"testedWithRealAccount":false`, both accounts. |
| Get an unknown plugin            | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_get '{"plugin":"nope"}'`                                                           | `"isError":true` and `There is no plugin with that id.`                                                                                               |
| Compare with the control API     | `curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins"`                                                                                        | `fixture` with `"available":true`, `"accountCount":2`, `"needsAddress":false`.                                                                        |

## Gotchas

Prefix every command with the `export URL=... TOKEN=...;` line from
`verify/README.md`, and reset first. The fixture plugin has no skills; a
`skills/<name>/SKILL.md` folder added to the instance catalogue copy appears in
`plugin_get` after the next reload.
