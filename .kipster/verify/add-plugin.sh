#!/bin/sh
# Adds a copy of the fixture plugin under another id to the instance catalogue,
# atomically. Usage: sh .kipster/verify/add-plugin.sh second Second
set -eu
: "${URL:?Set URL to the instance origin}"
catalogue=/tmp/kipster-plugins-verify-${URL##*:}/catalogue
id=$1
name=$2
staging="$catalogue/.$id.tmp"
rm -rf "$staging"
mkdir -p "$staging"
node -e '
const fs = require("node:fs")
const [source, target, id, name] = process.argv.slice(1)
const manifest = JSON.parse(fs.readFileSync(`${source}/plugin.json`, "utf8"))
const ext = manifest.extensions["app.kipster"]
manifest.name = ext.id = id
ext.name = name
fs.writeFileSync(`${target}/plugin.json`, JSON.stringify(manifest, null, 2))
fs.writeFileSync(`${target}/mcp.json`, JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { [id]: { type: "streamable-http", url: `https://${id}.kipster.test/mcp` } },
}, null, 2))
' test/fixtures/catalogue/fixture "$staging" "$id" "$name"
rm -rf "${catalogue:?}/$id"
mv "$staging" "$catalogue/$id"
echo "Added $catalogue/$id"
