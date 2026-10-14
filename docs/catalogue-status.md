# Catalogue status

Every plugin in `plugins/` was probed on 2026-10-13 with the read-only live probe described in [the plugin format](plugin-format.md#read-only-probe). Each plugin's `plugin.json` records its result. To reproduce this report:

```sh
npm run probe -- --report /tmp/probe.md
```

Vendors change, so a later run can differ. Only `todoist` has been tested with a real account.

## Counts

| Result          | Plugins |
| --------------- | ------: |
| `ok`            |     247 |
| `needs-address` |       6 |
| Total           |     253 |

All 253 plugins are available. Probed on 2026-10-14 for the 20 changed below.

## Plugins that are not ok

### `needs-address` (6)

Available. The person enters their own server address when connecting.

| Id               | Name           | Reason                                                         |
| ---------------- | -------------- | -------------------------------------------------------------- |
| `activecampaign` | ActiveCampaign | An instance or account MCP address is required when connecting |
| `aha`            | Aha!           | An instance or account MCP address is required when connecting |
| `home-assistant` | Home Assistant | An instance or account MCP address is required when connecting |
| `mattermost`     | Mattermost     | An instance or account MCP address is required when connecting |
| `metabase`       | Metabase       | An instance or account MCP address is required when connecting |
| `retool`         | Retool         | An instance or account MCP address is required when connecting |

## Sign-in with Kipster's client metadata document

These services sign in only with a client ID metadata document (CIMD), so they read Kipster's at `https://kipster.app/oauth/client-metadata.json`. It lists only loopback return addresses, so they connect only on the computer running Kipster: `affinity-crm`, `aircall`, `binance`, `bubble`, `elevenlabs`, `hubstaff`, `justworks`, `luma`, `nimble`, `relay`, `seeking-alpha`, `shop`, `softr`, `tableau`.

## Addresses that moved

`manus` (`https://mcp.manus.im/mcp`), `tl-dv` (`https://mcp.tldv.io/mcp`), `new-relic` (`https://mcp.newrelic.com/mcp/`) and `elevenlabs` (`https://api.us.elevenlabs.io/v1/mcp`).

## Removed

Removed on 2026-10-14 because sign-in cannot work today. Their research rows stay in `docs/research/class-a-services.csv`.

| Id                                                 | Reason                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `crowdstrike`, `ironclad`, `public`                | Refuse Kipster's client metadata document (not a trusted client)              |
| `unsplash`                                         | Its authorization endpoint rejects client metadata documents (unknown client) |
| `homey`                                            | Authorization server does not advertise S256 PKCE                             |
| `base`, `paytm`, `sprout-social`, `stack-overflow` | No protected resource metadata                                                |
| `keap`, `omnisend`, `rappi`                        | Authorization metadata issuer does not match                                  |
| `adobe-creative`, `genspark`                       | MCP endpoint refuses requests (HTTP 403, bot check)                           |
| `legalzoom`                                        | No sign-in at all                                                             |
| `plausible`                                        | MCP endpoint answers HTTP 501                                                 |
| `slab`                                             | MCP endpoint answers HTTP 400 without a client                                |
| `coros`                                            | One address per region; its metadata names the regional server                |

## Sign-in methods that differ from research

69 plugins record plugin-level `signIn` methods that differ from their research `products[].signIn`. The research value stays unchanged; the plugin-level value follows discovery.

| Research     | Plugin `signIn` | Probe observed | Plugins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth-cimd` | `cimd`, `dcr`   | `dcr`, `cimd`  | `airtable`, `any-do`, `apify`, `atlassian`, `basecamp`, `birdeye`, `classdojo`, `clerk`, `cloudflare`, `context7`, `datacamp`, `deepl`, `descript`, `etoro`, `exa`, `expo`, `firecrawl`, `fireflies-ai`, `float`, `folk`, `freepik`, `glide`, `grafana`, `granola`, `have-i-been-pwned`, `heygen`, `honeycomb`, `hugging-face`, `keepa`, `klaviyo`, `linear`, `linktree`, `lovable`, `lucid`, `midjourney`, `mural`, `notion`, `nuclino`, `ourgroceries`, `pcloud`, `photoroom`, `picsart`, `posthog`, `railway`, `recurly`, `remote`, `resend`, `roam-research`, `sentry`, `slite`, `smartsuite`, `sonos`, `suno`, `sunsama`, `superhuman`, `synthesia`, `tana`, `tavily`, `todoist`, `trello`, `turkish-airlines`, `turso`, `typeform`, `typefully`, `unbounce`, `upwork`, `wispr-flow` |
| `oauth-dcr`  | `cimd`, `dcr`   | `dcr`, `cimd`  | `monday-com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `oauth-cimd` | `cimd`, `dcr`   | `dcr`, `cimd`  | `tl-dv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Needs an owner account test

- `upwork` (ok): its research notes say the advertised `registration_endpoint` points at a sign-up page, so DCR sign-in may fail. CIMD is advertised too.
- `monday-com` (ok): the probe observes `dcr`, `cimd`, while its research notes recorded no CIMD and client secret methods only.
- Services that answered the anonymous initialize request and also offer OAuth: `amazon-web-services`, `context7`, `datacamp`, `deel`, `exa`, `gorgias`, `gusto`, `have-i-been-pwned`, `hugging-face`, `storyblok`, `teamwork-com`. An account test confirms that sign-in and the signed-in tools work.
