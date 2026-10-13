# Releasing

The repository releases one package, `@kipster/plugins`: the plugin server with
its catalogue, compiled to JavaScript. Kipster installs it from GitHub releases
like its own packages. Nothing is published to npm.

## Branches

| Branch   | Purpose                                                        |
| -------- | -------------------------------------------------------------- |
| `next`   | Default and integration branch. Every pull request targets it. |
| `master` | Stable releases. Updated only by merging `next`, by the owner. |

## Versions

The version is `version` in `package.json`, below 1.0 during the beta. Raise it
in the pull request that should ship: patch for fixes, minor for features.

## Release files

The **Release** workflow builds, checks and packs the package, then publishes a
GitHub release tagged `plugins-v<version>` with:

- `kipster-plugins-<version>.tgz`, the package;
- `release.json`: `schemaVersion` 1, `package`, `version` and `files`, each
  with `name`, `size` and `sha256`.

It never publishes a version twice.

- **Stable:** runs on every push to `master`.
- **Next:** run it on `next` from the Actions tab, or
  `gh workflow run release.yml --ref next`. It publishes
  `<version>-next.<UTC timestamp>` as a pre-release.
