# Kipster Plugins

Kipster Plugins connects Kipster's agents to the services people use. A plugin
server runs on the person's own computer. It holds plugins, signed-in accounts
and secrets, and serves each plugin's tools over MCP. User-facing text calls
agents _kips_; code and documentation say agent.

Read the [plan](docs/plan.md) before changing behavior. It records what is
settled, what the first version contains and what comes later. Current owner
instructions take precedence over it.

## Working rules

- Understand the requested outcome and the existing code before changing
  anything. Challenge assumptions and raise material gaps up front.
- Never claim something works without testing it. Report what you tested, the
  results, and what is still unverified. Follow the
  [testing guide](.kipster/context/testing.md).
- The plugin server runs standalone. It never imports Kipster code or depends on
  a Kipster installation. Kipster reaches it only through MCP and the control
  API.
- Change the control API and MCP surface by addition only. Released Kipster
  versions must keep working.
- Plugins for services with an official MCP server (class A) are configuration,
  not code. One generic remote MCP implementation serves all of them. Add
  per-service code only for the special cases the plan names.
- Add a plugin's skills only when the service publishes official ones, or the
  owner asks for them.
- Tools nobody has reviewed count as write tools.
- Never commit credentials, tokens, client secrets or real account data. Tests
  use the local fixture service, never a real account.
- Start each task on a new branch from the latest `origin/next`. Open pull
  requests against `next`. The owner merges, and only the owner merges into
  `master`.
- Run `npm run check` before every commit you hand over. CI runs the same
  command.
- Keep public documentation concise. Leave task history, conversation notes and
  personal environment details out of the repository.
