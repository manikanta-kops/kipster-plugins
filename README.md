<p align="center">
  <img src="docs/assets/under-construction.gif" alt="Kip in a hard hat watches a crane lower plugin blocks into place" width="800">
</p>

<p align="center">
  <b>Plugins for your kips.</b><br>
  Connect your kips to the services you already use.
</p>

<p align="center">
  <b>Under construction.</b> Nothing here is ready to use yet.
</p>

## What is Kipster Plugins

[Kipster](https://github.com/manikanta-kops/kipster) gives you personal AI agents
called kips. Kipster Plugins lets them work with the services you use, such as
GitHub, Jira, Notion and Linear, through your own accounts.

The plugin server runs on your own computer, next to Kipster. Your sign-ins stay
there, and nothing passes through a Kipster server.

## How it fits

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-fits-dark.png">
  <img src="docs/assets/how-it-fits-light.png" alt="Kipster asks the plugin server, and the plugin server talks to services such as GitHub, Jira, Notion and Linear" width="720">
</picture>

- **Kipster** is where your kips live. They ask the plugin server for what they need.
- **The plugin server** holds your plugins and signed-in accounts, and talks to each service.
- **Services** are the apps you already use. Most offer an official MCP server that
  the plugin server connects to.

Kipster bundles and starts the plugin server. You can also run it on its own.

## Every plugin has four parts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/plugin-parts-dark.png">
  <img src="docs/assets/plugin-parts-light.png" alt="A plugin has skills, tools, listeners and accounts" width="100%">
</picture>

- **Skills** teach a kip how to do common jobs with the service, such as reviewing
  your open pull requests.
- **Tools** are the actions a kip can take, such as creating an issue.
- **Listeners** are events that start a kip, such as a new comment on a pull request.
- **Accounts** are your signed-in accounts. A plugin can hold several, such as a
  work and a personal GitHub account.

New plugins arrive as updates, without restarting anything.

## Plan

The first version connects to services that offer an official MCP server with a
normal browser sign-in. Each of those plugins is configuration, not code. The full
plan is in [docs/plan.md](docs/plan.md).

1. The plugin server: loading plugins, sign-in, several accounts per plugin, and tools.
2. The first plugins, tested with real accounts.
3. A regular check that every listed service's MCP server still answers.
4. Later: GitHub, listeners, and services that need more setup.

## Running the server

```sh
npm run serve -- --port 8790 --home ~/.kipster-plugins
```

The server listens on `127.0.0.1` only and prints its URL as one JSON line.
`--home` is required and holds the state, encrypted secrets and the bearer
token (`<home>/token`, or `KIPSTER_PLUGINS_TOKEN`). The catalogue defaults to
`plugins/` (`--catalogue <dir>`); the secret store key is in the macOS keychain
or, elsewhere, a file in the home (`--key-backend keychain|file`). Connect an
MCP client to `<url>/mcp` with the token; plugins, sign-in and accounts use the
[control API](docs/control-api.md).

## Development

Use Node from `.nvmrc`, then `npm ci` to install locked dependencies.

- `npm run check`: formatting, TypeScript, all tests, then catalogue validation.
- `npm test`: deterministic tests on temporary folders and loopback stubs.
- `npm run import -- Linear Notion`: generate configurations from the research CSV.
- `npm run probe -- linear notion`: read-only live discovery, without sign-in.
- `npm run validate`: validate every catalogue folder.
- `npm run fixture -- --port 8765`: start the local fixture service used by the tests.
- `npm run instance -- --port 8790 --fixture-port 8765`: the fixture service and a
  plugin server pointed at it, as the factory's verify instance runs them.
- `npm run mcp -- --url <url> --token <token> list`: a small MCP client (`list`,
  `call <tool> '<json>'`, `watch`).
- `npm run format`: format repository files.

See [the plugin format](docs/plugin-format.md) for batch imports and probe
results, [the control API and MCP endpoint](docs/control-api.md),
[sign-in and accounts](docs/sign-in-and-accounts.md),
[the fixture service](docs/fixture-service.md), and
[testing](.kipster/context/testing.md) for verification levels.

## Status

Under construction. Not yet a release.

## License

[Apache-2.0](LICENSE)
