# Working on YAPA

Notes for changing YAPA itself. To install or use it, see [README.md](README.md).

## Build and test

- `npm ci`, then `npm run build:all`: the workspaces, then the plugin bundle in `plugin/dist`.
- `npm test` builds first, then runs every workspace's tests: core, mcp, dsh, service and mcp-remote. The mcp and DSH tests import the built `@yapa/core`. The first run downloads the embedding model.
- Under vitest, the scope file, sync health, lease and coordination state default to temp paths. Tests set their own store and config; don't rely on the defaults for anything else.
- Suites against real databases and services are opt-in: see [docs/sync.md](docs/sync.md#testing-sync).
- Docs are part of a change. A user-visible behavior goes in the README or the page under `docs/` that covers it.

## Pull requests

Feature and fix PRs leave `CHANGELOG.md` and `plugin/dist/` alone:
- Put the release-note entry in the PR description instead, written as it should appear under the next version.
- Don't commit rebuilt bundles. Run `npm run build:all` to test, then restore `plugin/dist/`.
- Only the release PR adds the dated CHANGELOG section, from the merged PRs' entries, and commits the rebuilt bundles.

That way open PRs don't conflict with each other and can merge in any order.

## Releasing

1. Bump `"version"` in the eight manifests: `package.json`, `packages/{core,dsh,mcp,service,mcp-remote}/package.json`, `plugin/package.json` and `plugin/.claude-plugin/plugin.json`.
2. Bump the matching seven lines in `package-lock.json` by hand: the root's top-level `version`, its `packages[""]` entry, and the five workspace entries (core, dsh, mcp, mcp-remote, service). Leave every dependency's version alone.
3. Run `npm run build:all` and `npm test`.
4. Add the dated CHANGELOG section, with an **Upgrading** note when users must do anything.
5. Open the release PR with the bumped files and the rebuilt bundles.
6. After it merges, tag the merge commit (`git tag -a vX.Y.Z`), push the tag, and publish the GitHub release with the CHANGELOG section as its notes.

Users pick it up with `claude plugin marketplace update yapa && claude plugin update yapa@yapa`, then a restart.
