#!/bin/sh
# Signs a fixture user in through the control API, completing the fixture's
# consent the way a browser would, then prints the sign-in status.
# Usage: sh .kipster/verify/sign-in.sh <alice|bob|deny> [plugin]
set -eu
: "${URL:?Set URL to the instance origin}"
TOKEN=${TOKEN:-kipster-verify-token-not-secret}
user=$1
plugin=${2:-fixture}
start=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$URL/v1/plugins/$plugin/sign-in")
auth=$(node -pe 'JSON.parse(process.argv[1]).authorizationUrl ?? ""' "$start")
if [ -z "$auth" ]; then
  echo "$start"
  exit 1
fi
id=$(node -pe 'JSON.parse(process.argv[1]).id' "$start")
back=$(curl -sS -o /dev/null -w '%{redirect_url}' "$auth&user=$user")
curl -sS -o /dev/null -w 'callback %{http_code}\n' "$back"
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/v1/sign-ins/$id"
echo
