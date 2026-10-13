#!/bin/sh
# Returns the instance to its starting state: removes every account (revoking
# it at the fixture) and restores the fixture catalogue. Fixture notes remain.
# Usage: sh .kipster/verify/reset.sh
set -eu
: "${URL:?Set URL to the instance origin}"
TOKEN=${TOKEN:-kipster-verify-token-not-secret}
catalogue=/tmp/kipster-plugins-verify-${URL##*:}/catalogue
accounts=$(curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts")
for id in $(node -pe 'JSON.parse(process.argv[1]).accounts.map((a) => a.id).join(" ")' "$accounts"); do
  curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$URL/v1/accounts/$id"
  echo
done
find "$catalogue" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R test/fixtures/catalogue/. "$catalogue/"
echo "Reset $URL"
