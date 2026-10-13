# Catalogue reload

## Sub-features

- A plugin folder added to the catalogue appears without a restart.
- An invalid edit keeps the last good version.
- A removed plugin's tools disappear; its accounts stay stored.
- Connected MCP sessions receive `notifications/tools/list_changed`.

## How to get to it (user point of view)

A catalogue update replaces plugin folders while the server runs. Here, edit
the instance's catalogue copy at `/tmp/kipster-plugins-verify-<port>/catalogue`.

## Driving it

| User action                 | Exact command                                                                                                                                                             | Observable result                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Watch for tool list changes | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" watch --seconds 60 > "$EVIDENCE_DIR/watch.log" 2>&1 &`                                                             | `watch.log` starts with `{"event":"watching","seconds":60}`.                                                    |
| Add a plugin                | `sh .kipster/verify/add-plugin.sh second Second; sleep 1; curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins"`                                                   | `Added .../second`, then plugins `fixture` and `second`; `watch.log` gains a `tools/list_changed` line.         |
| See it in discovery         | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" call plugin_list '{"include_unconnected":true}'`                                                                   | Plugins `fixture` and `second`.                                                                                 |
| Connect it and list tools   | `sh .kipster/verify/sign-in.sh alice second; npm run --silent mcp -- --url "$URL" --token "$TOKEN" list`                                                                  | `second__whoami` (read) and `second__create_note` (write) are listed.                                           |
| Break its manifest          | `printf '{ broken' > "/tmp/kipster-plugins-verify-${URL##*:}/catalogue/second/plugin.json"; sleep 1; curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/second"` | Still `"name":"Second"`; the start log reports the invalid folder; `second__whoami` is still listed.            |
| Remove it                   | `rm -rf "/tmp/kipster-plugins-verify-${URL##*:}/catalogue/second"; sleep 1; curl -sS -w ' %{http_code}\n' -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/second"`     | `{"error":{"code":"unknown-plugin",...}} 404`.                                                                  |
| Check its tools are gone    | `npm run --silent mcp -- --url "$URL" --token "$TOKEN" list`                                                                                                              | No `second__` tools.                                                                                            |
| Check its account stayed    | `curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts?plugin=second"`                                                                                             | One account labelled `alice@fixture.test`.                                                                      |
| Read the notifications      | `cat "$EVIDENCE_DIR/watch.log"`                                                                                                                                           | One `{"event":"tools/list_changed",...}` line per change: added, connected, removed; the broken edit adds none. |

## Gotchas

Prefix every command with the `export URL=... TOKEN=...;` line from
`verify/README.md`, and reset first, which also restores the catalogue. Edits
are picked up within about a second (filesystem events, plus a rescan every
second). Write folders atomically, as `add-plugin.sh` does; a half-written
folder is reported invalid until it is complete. The watch runs in the
background and exits after its seconds.
