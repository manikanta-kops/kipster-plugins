# Kipster Plugins: plan

Status: agreed direction, 13 October 2026. Nothing is built yet. This plan
records what is settled, what the first version contains, and what comes later.

## Goal

Let kips work with the services a person already uses, through the person's own
accounts, with every sign-in kept on the person's own computer.

## Settled decisions

- **Name.** These are *plugins*. A plugin connects kips to one service.
- **Four parts.** A plugin can have skills, tools, listeners and accounts.
- **Own repository, open source.** Kipster bundles and starts the plugin server.
  Anyone can also run it alone.
- **One person per server.** No multi-user or team mode.
- **Everything runs on the person's computer.** No Kipster-run server in the
  middle: no relay, no hosted sign-in page, no hosted webhook receiver. People
  reach their computer from other devices through their own Tailscale network.
- **First-party plugins only.** Kipster builds and checks each plugin, on the
  service's official MCP server where one exists. No aggregators such as
  Composio, Zapier or Pipedream: personal data must not pass through a third
  party's cloud.
- **Models never talk to the plugin server directly.** Kipster passes the tools
  through, so switching a kip between Codex and Claude changes nothing.
- **Several accounts per plugin.** One set of tools per plugin, with an
  `account` argument.
- **Start with class A.** Services with an official MCP server and a normal
  browser sign-in that needs no app registration. Other classes come later.
- **Standards.** Plugins follow the open Agent Plugins 1.0 layout, Agent Skills
  and MCP. Kipster depends on nothing else. Claude Code or Codex manifests are
  generated only if ever needed.

## The four parts

| Part | What it is | First version |
| --- | --- | --- |
| Skills | `SKILL.md` instructions for common jobs, such as "review my open PRs" | Supported; written for the most used plugins over time |
| Tools | Actions a kip can call, served by the service's MCP server | Yes |
| Listeners | Events that start a kip, such as "new comment on PR #12" | Shape only; first listener later (GitHub) |
| Accounts | The person's signed-in accounts, several per plugin | Yes |

## Architecture

```text
 Person's devices --(Tailscale)--> Kipster Core --(local socket)--> Plugin server --(HTTPS)--> Service MCP servers
                                   passes tools to kips              plugins, accounts,          Notion, Linear,
                                   applies approvals                 sign-in, secrets,           Atlassian, ...
                                                                     discovery tools
```

### One repository, two release outputs

- **The plugin server** is the program. It changes rarely and is updated with
  Kipster.
- **The plugin catalogue** is the set of plugin folders, mostly JSON and
  Markdown. It is released as a separate versioned bundle.
- The server loads a new catalogue **while running, with no restart**. Kipster
  shows "Plugin updates available" with an Update button, following the
  person's update settings.
- Later, plugins with their own code run as separate small processes, started
  on demand, so they also need no restart.

### How Kipster talks to the plugin server

- When bundled: a Unix socket in a private folder; file permissions are the
  authentication. When standalone: loopback with a bearer token.
- **Tools: MCP.** All plugin tools, plus the discovery tools, on one MCP endpoint.
- **Everything else: a small versioned control API.** Plugins, accounts, sign-in,
  catalogue updates and, later, listeners.
- **Events (later):** the plugin server writes each event to an outbox; Kipster
  reads from its last confirmed point, saves the event, then confirms.
- Changes to the API are additive only, with capability flags, like Kipster's
  own protocol.

### Who owns what

- **The plugin server owns everything about plugins:** the catalogue, plugin
  settings, accounts and labels, secrets, sign-in, and the discovery tools
  (`plugin_list`, `plugin_get`). Standalone use therefore never depends on
  Kipster.
- **Kipster Core owns what applies to all tools:** passing tools to each
  harness, approvals and permission modes, and its admin tools, which call the
  plugin server's control API so Kip can manage everything a person can.
- Kipster's AGENTS.md rule "keep every setting in Core" needs rewording:
  plugin settings live in the plugin server and are reachable through Core's
  admin tools.

## Plugin format

A plugin is a folder in the Agent Plugins 1.0 layout. Kipster-specific data
lives under the `app.kipster` extension namespace.

```text
notion/
├── plugin.json            Agent Plugins 1.0, plus extensions["app.kipster"]
├── mcp.json               the service's MCP server and how to sign in
├── skills/                optional SKILL.md files
└── app.kipster/           optional: tool labels, listeners (later)
```

A class A plugin is configuration only:

- name, description and category;
- MCP server URL;
- sign-in method (self-registering or client metadata document);
- account types (personal, business) and whether the person's paid plan is needed;
- optional skills.

One generic "remote MCP" implementation serves every class A plugin. The exact
schema is settled in the first build task.

Special cases in class A:

- **Needs the person's own address** (Home Assistant, Mattermost, Aha!,
  ActiveCampaign): the plugin asks for it when connecting.
- **Older SSE transport** (Any.do): supported by the MCP SDK.
- **One server, several products** (Atlassian Rovo covers Jira, Confluence and
  Bitbucket): one plugin.

The services and their MCP URLs are in
[research/class-a-services.csv](research/class-a-services.csv): 275 class A
services from the October 2026 research, with sign-in method, account types,
cost, verification level and sources. Re-check a row before relying on it;
vendors change their MCP servers often.

## Sign-in

- **Two ways Kipster introduces itself**, both handled by the official MCP SDK:
  - *Self-registering (DCR):* Kipster registers itself with the service during
    sign-in.
  - *Client metadata document (CIMD):* the service reads a small public JSON
    file that describes Kipster. This is one static file at a public address we
    own, not a server. Many services accept both; prefer DCR until the file
    exists.
- **The return address is visited by the person's browser, not by the service.**
  So it never needs to be reachable from the internet:
  - *On the same computer:* `http://127.0.0.1:<port>/callback`.
  - *From another device:* the computer's Tailscale address, where the service
    accepts it (DCR only). Atlassian allows only localhost by default; there,
    sign in on the computer itself.
- **Tokens** are stored encrypted on disk, with the key in the operating
  system's keychain. Refresh runs under a lock per account, because refresh
  tokens rotate.
- Each account shows its state: working, or "reconnect needed".

## Multiple accounts

- **One sign-in is one account.** Organisations, sites and workspaces an account
  can reach are resources, not accounts. Exception: services that issue one
  token per workspace (Slack, Notion, Linear) make each workspace its own
  account.
- **No duplicates.** After every sign-in the server asks the service who the
  account is and keys it by a stable ID (for example GitHub's numeric user ID,
  never the login name). Adding the same account again refreshes it instead.
- **Labels** default to the login or email; the person can rename them.
- **The `account` argument** appears only when a plugin has two or more
  accounts, and lists the labels. The account is chosen in this order:
  1. the account the kip passed;
  2. a routing rule, such as "repos under `acme/` use work";
  3. the only account that can reach the target;
  4. a default;
  5. the only account.

  Otherwise the call returns "ambiguous" with the candidates, and the kip asks
  the person.
- Every result says which account was used. One call uses one account.
- **Adding a second account** when the browser is already signed in: ask the
  service to show its account picker where supported, otherwise open the
  sign-in in a private window.

## Tools, and how kips find them

- Tool names are `<plugin>__<tool>`: letters, digits, `_` and `-`, at most 64
  characters.
- Each tool is labelled **read** or **write**. MCP's own hints are untrusted by
  the specification's own rules. Tools nobody has reviewed count as write, so
  Kipster asks before they act.
- **Discovery tools live in the plugin server:**
  - `plugin_list` lists connected plugins and their accounts.
  - `plugin_get` returns one plugin's accounts, skills and tool names.

  Kipster passes them through like any other tool.
- Each tool can carry a hint telling Kipster whether to load it up front or
  leave it for the harness's tool search. Claude Code and Codex both support
  tool search. Loading hundreds of tools at once hurts accuracy.

## Testing

We cannot hold an account for every service, so testing has three levels:

1. **No account, every plugin, automatic:** call each MCP URL and check that it
   answers "sign-in required" and publishes its sign-in details. This proves the
   server is alive and confirms the sign-in method. Run it on every change and
   on a schedule.
2. **Real sign-in:** sign in, list the tools and run one read-only action. Done
   for the plugins we use, and at least one self-registering and one
   client-metadata service, which proves the shared mechanism.
3. **Everything else** ships marked "not yet tested with a real account", with
   its tools treated as write until reviewed.

Test accounts belong to the project, never to a person's own account.

## Listeners (shape now, build later)

- The plugin server has a listener slot from the first version: an event type,
  a filter, a cursor ("everything since here") and an outbox.
- **GitHub comes first**, after Kipster has Schedules with event triggers. Its
  notifications check covers every thread the person takes part in, needs no
  public address, and costs nothing when nothing has changed.
- More services are added one at a time. Preferred mechanisms, best first:
  1. an outbound live connection from the computer;
  2. a change feed with a cursor;
  3. webhooks, later and only as an opt-in through the person's own Tailscale
     Funnel;
  4. notification emails;
  5. a single batched check, as the last resort.
- Listener events from people the owner does not trust only notify the person;
  they never start a kip on their own.

## First version (v1)

1. **Plugin server foundation:** project setup, configuration, the local socket,
   the control API, the encrypted secret store, and loading the catalogue with
   live reload.
2. **Sign-in and accounts:** DCR and CIMD sign-in through the MCP SDK, several
   accounts per plugin, duplicate detection, labels, token refresh and
   reconnect state.
3. **Tools:** proxying class A MCP servers, the `account` argument and its
   resolution, read/write labels, and the discovery tools.
4. **Catalogue:** class A plugin configurations generated from the research
   file, plus the automatic no-account check for all of them.
5. **First real-account plugins:** a short list chosen by the owner, tested
   end to end.

Work in the Kipster repository, tracked there:

- passing plugin tools to kips, with the load-up-front or search hint;
- the Connect screen, the account list and "Plugin updates available";
- admin tools that call the control API;
- the AGENTS.md rewording above.

## Later

- **GitHub:** first with a token the person pastes; later "Sign in with GitHub"
  through an app the project registers once with GitHub.
- **Class B:** pasted keys and tokens, the service's own local MCP server, and
  apps the project registers once (GitHub, Microsoft, Asana). A registered app
  is only an entry on the service's developer site. No traffic passes through
  the project.
- **Services without an MCP server:** tools we write on their public API.
- **Listeners** after GitHub.
- **Pinning:** fingerprints of each tool's schema, with changed tools hidden
  until reviewed.

## Rejected

- Aggregators (Composio, Zapier, Pipedream and similar).
- Any Kipster-run relay or hosted service in the data path.
- Asking each person to register their own developer app.
- Picking and injecting tools per message: it breaks prompt caching and misses
  tools.

## Open questions

- Which plugins come first with real accounts, and which test accounts the
  project holds.
- Whether GitHub with a pasted token joins the first version.
- The public address for the client metadata document (for example on
  `kipster.app`).

## Technology

- TypeScript on Node, matching Kipster's Node version, with npm.
- The official MCP TypeScript SDK (version 2) for both the client and server sides.
- SQLite for the plugin server's own state.
- Apache-2.0.
