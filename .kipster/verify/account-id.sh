#!/bin/sh
# Prints the id of the account with this label (any plugin, case-insensitive).
# Usage: sh .kipster/verify/account-id.sh bob@fixture.test
set -eu
: "${URL:?Set URL to the instance origin}"
TOKEN=${TOKEN:-kipster-verify-token-not-secret}
accounts=$(curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts")
node -e '
const [json, label] = process.argv.slice(1)
const found = JSON.parse(json).accounts.find(
  (a) => a.label.toLowerCase() === label.toLowerCase(),
)
if (!found) {
  console.error(`No account labelled ${label}`)
  process.exit(1)
}
console.log(found.id)
' "$accounts" "$1"
