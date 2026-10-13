# Catalogue status

Every plugin in `plugins/` was probed on 2026-10-13 with the read-only live probe described in [the plugin format](plugin-format.md#read-only-probe). Each plugin's `plugin.json` records its result. To reproduce this report:

```sh
npm run probe -- --report /tmp/probe.md
```

Vendors change, so a later run can differ. No plugin has been tested with a real account.

## Counts

| Result                           | Plugins |
| -------------------------------- | ------: |
| `ok`                             |     230 |
| `needs-address`                  |       6 |
| `needs-client-metadata-document` |      17 |
| `sign-in-changed`                |       2 |
| `unreachable`                    |       1 |
| `error`                          |      15 |
| Total                            |     271 |

236 plugins are available: `ok` and `needs-address`. The other 35 stay in the catalogue, unavailable with their reason.

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

### `needs-client-metadata-document` (17)

These services sign in only with a client ID metadata document. Setting `KIPSTER_PLUGINS_CLIENT_METADATA_URL` to a public HTTPS client metadata document unblocks them.

| Id              | Name           | Reason                                            |
| --------------- | -------------- | ------------------------------------------------- |
| `affinity-crm`  | Affinity (CRM) | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `aircall`       | Aircall        | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `binance`       | Binance        | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `bubble`        | Bubble         | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `crowdstrike`   | CrowdStrike    | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `hubstaff`      | Hubstaff       | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `ironclad`      | Ironclad       | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `justworks`     | Justworks      | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `luma`          | Luma           | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `nimble`        | Nimble         | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `public`        | Public         | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `relay`         | Relay          | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `seeking-alpha` | Seeking Alpha  | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `shop`          | Shop           | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `softr`         | Softr          | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `tableau`       | Tableau        | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |
| `unsplash`      | Unsplash       | CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL |

### `sign-in-changed` (2)

The authorization server does not advertise S256 PKCE, which sign-in requires. They stay unavailable until it does.

| Id      | Name  | Reason                                            |
| ------- | ----- | ------------------------------------------------- |
| `homey` | Homey | Authorization server does not advertise S256 PKCE |
| `paytm` | Paytm | Authorization server does not advertise S256 PKCE |

### `unreachable` (1)

The service failed on the first run and again on a retry a few minutes later. A later probe may succeed.

| Id          | Name      | Reason                                         |
| ----------- | --------- | ---------------------------------------------- |
| `plausible` | Plausible | Service returned HTTP 5xx after three attempts |

### `error` (15)

| Id               | Name           | Reason                                                      |
| ---------------- | -------------- | ----------------------------------------------------------- |
| `adobe-creative` | Adobe Creative | Expected HTTP 401; received HTTP 403                        |
| `base`           | Base           | No discovery metadata was found                             |
| `coros`          | COROS          | Protected resource metadata does not match the MCP endpoint |
| `elevenlabs`     | ElevenLabs     | Protected resource metadata does not match the MCP endpoint |
| `genspark`       | Genspark       | Expected HTTP 401; received HTTP 403                        |
| `keap`           | Keap           | Authorization metadata issuer does not match                |
| `legalzoom`      | LegalZoom      | Authorization metadata issuer does not match                |
| `manus`          | Manus          | Expected HTTP 401; received HTTP 404                        |
| `new-relic`      | New Relic      | Protected resource metadata does not match the MCP endpoint |
| `omnisend`       | Omnisend       | Authorization metadata issuer does not match                |
| `rappi`          | Rappi          | Discovery returned HTTP 403                                 |
| `slab`           | Slab           | Expected HTTP 401; received HTTP 400                        |
| `sprout-social`  | Sprout Social  | Authorization metadata issuer does not match                |
| `stack-overflow` | Stack Overflow | No discovery metadata was found                             |
| `tl-dv`          | tl;dv          | Expected HTTP 401; received HTTP 404                        |

## Sign-in methods that differ from research

69 plugins record plugin-level `signIn` methods that differ from their research `products[].signIn`. The research value stays unchanged; the plugin-level value follows discovery.

| Research     | Plugin `signIn` | Probe observed | Plugins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth-cimd` | `cimd`, `dcr`   | `dcr`, `cimd`  | `airtable`, `any-do`, `apify`, `atlassian`, `basecamp`, `birdeye`, `classdojo`, `clerk`, `cloudflare`, `context7`, `datacamp`, `deepl`, `descript`, `etoro`, `exa`, `expo`, `firecrawl`, `fireflies-ai`, `float`, `folk`, `freepik`, `glide`, `grafana`, `granola`, `have-i-been-pwned`, `heygen`, `honeycomb`, `hugging-face`, `keepa`, `klaviyo`, `linear`, `linktree`, `lovable`, `lucid`, `midjourney`, `mural`, `notion`, `nuclino`, `ourgroceries`, `pcloud`, `photoroom`, `picsart`, `posthog`, `railway`, `recurly`, `remote`, `resend`, `roam-research`, `sentry`, `slite`, `smartsuite`, `sonos`, `suno`, `sunsama`, `superhuman`, `synthesia`, `tana`, `tavily`, `todoist`, `trello`, `turkish-airlines`, `turso`, `typeform`, `typefully`, `unbounce`, `upwork`, `wispr-flow` |
| `oauth-dcr`  | `cimd`, `dcr`   | `dcr`, `cimd`  | `monday-com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `oauth-cimd` | `cimd`, `dcr`   | none           | `tl-dv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Needs an owner account test

- `upwork` (ok): its research notes say the advertised `registration_endpoint` points at a sign-up page, so DCR sign-in may fail. CIMD is advertised too.
- `monday-com` (ok): the probe observes `dcr`, `cimd`, while its research notes recorded no CIMD and client secret methods only.
- Services that answered the anonymous initialize request and also offer OAuth: `amazon-web-services`, `context7`, `datacamp`, `deel`, `exa`, `gorgias`, `gusto`, `have-i-been-pwned`, `hugging-face`, `storyblok`, `teamwork-com`. An account test confirms that sign-in and the signed-in tools work.
