# Plugins

A plugin is a bundle of skills and MCP tools an agent can use, installed per user account and
materialized onto every machine that account signs into. First-party ones live in `plugins/<name>/`
and are listed in `.agent-marketplace.json` at the repo root.

## What is source and what is generated

Only three things in a plugin directory are hand-written:

| Path | Owner |
| --- | --- |
| `plugins/<name>/plugin.json` | you |
| `plugins/<name>/skills/*/SKILL.md` | you |
| `plugins/<name>/src/index.ts` | you (optional MCP server) |
| `plugins/<name>/server/` | `superset plugins build` |
| `plugins/<name>/versions/<v>/` | `superset plugins publish` |
| `.agent-marketplace.json` | `superset plugins create` / `publish` |
| `packages/shared/src/plugins/manifests.generated.ts` | `superset plugins publish` |

The generated four are excluded from biome (`biome.jsonc`) precisely because nothing should be
formatting them by hand. Editing them directly is the one way to get a marketplace that disagrees
with itself.

`versions/<v>/` exists because a host resolving a plugin at tool-call time has a marketplace repo and
a ref, not a git history — it fetches a path. `manifests.generated.ts` exists because the API must
resolve `token_url` and the proxy target *without* trusting anything client-supplied; a manifest
posted in a request would be an exfiltration path.

## Changing a plugin

```bash
superset plugins publish <name> --bump patch   # rewrites versions/, the marketplace entry, and the bundle
bun run check:plugins                          # what CI runs; catches a change that skipped publish
```

`check:plugins` fails on a `versions/<v>/` that no longer matches the source it was published from, a
marketplace entry whose version disagrees with `plugin.json`, a `server/` build that is stale against
`src/`, and a `manifests.generated.ts` that a publish would rewrite. Run it before pushing.

Bump the version rather than republishing over one that shipped: `--force` overwrites a snapshot
someone's account may already be pinned to.

## Manifest shape

`plugin.json` follows the Codex plugin vocabulary — `name`, `version`, `description`, `author`,
`license` — with everything Superset-specific under `extensions.superset`:

- `interface` — `displayName`, `category` (one of `PLUGIN_CATEGORIES` in
  `packages/shared/src/plugins/index.ts`), and `icon`.
- `auth` — an array of methods, each `oauth2` or `api_key`. OAuth entries carry
  `authorization_url`, `token_url`, `scopes`, `requires_env` (the client id/secret env names the API
  reads), an `identity` probe that names the connected account, and `bind`, which says how the
  credential is attached to outbound calls. `${config.access_token}` and `${inputs.<name>}`
  placeholders are resolved server-side by `apps/api/src/lib/plugins/manifest.ts`.
- `mcpServers` — server name → config, the same shape as an `.mcp.json` value. The name lands
  verbatim as a config key in agent CLIs.

Credentials never reach the manifest, the renderer, or the agent's machine. They are encrypted at
rest with `BETTER_AUTH_SECRET` (`apps/api/src/lib/plugins/crypto.ts`) and attached by the proxy in
`apps/api/src/lib/plugins/dispatch.ts`, so a tool call goes out from the API, not from the agent.

## Install state on a machine

One file, `$SUPERSET_HOME_DIR/plugins/installed_plugins.json`, records what is materialized. Note
`SUPERSET_HOME_DIR` — `SUPERSET_HOME` is the CLI installer's prefix (see
`apps/marketing/public/cli/install.sh`) and names nothing here.

Every provisioner reads that file: the desktop at boot, `superset plugins sync`, the host-service.
That is deliberate. Provisioning is *declarative* — `createManagedSkills` in `@superset/agent-setup`
writes the desired set and reaps whatever is absent, so a caller that hands in its own plugin list
instead of letting agent-setup read the file has just told it every other caller's plugins are gone.
The desktop's next boot would undo a `plugins sync`, and vice versa.

Skills land in `~/.agents/skills` (what Codex, Vibe, and Kimi read natively) and are mirrored into
`~/.claude/skills` as a plugin directory, because Claude does not read the shared convention.

## Command surface

```
superset plugins create|build|check|publish     # authoring
superset plugins install|remove|list|sync       # this machine
superset plugins connect|connections            # credentials
superset marketplace list|install|remove        # marketplace sources
superset mcp tools|call-tool                    # call a plugin's tools through the proxy
superset skills list
```
