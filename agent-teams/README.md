# Agent Teams for Huabu

This folder contains Huabu-managed Agent Teams: reusable external-agent packages that Huabu discovers, configures, prepares, and runs through Agenetes and connected agentlet daemons.

Each package remains a normal Agent Team defined by the generic [`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md) contract. Huabu adds the managed discovery, Config, deployment, setup, and runtime experience.

## Quick start

1. Ensure the machine containing these packages runs an agentlet daemon connected to Huabu.
2. Open **Settings → Agent Teams**.
3. Add the absolute path to this `agent-teams/` directory as a collection root on that machine.
4. Configure fields marked with a red `(*)`.
5. Select a harness, confirm the managed workspace path, create the deployment, and enable it.

Huabu asks Agenetes to scan the collection root, persists the discovered members and deployments, stores secret Configs in the host SecretStore, and runs package setup through the selected daemon. Users do not need to run setup or register an External Agent profile manually.

## Bundled teams

| Agent | Responsibility | Configs | Harnesses |
| --- | --- | --- | --- |
| [`deepv-slides-maker/`](./deepv-slides-maker/) | Creates editable slide decks through a DeepV server. | `DEEPV_SERVER_ENDPOINT`, `DEEPV_SERVER_API_KEY` | `claude`, `copilot` |
| [`hackmd-publisher/`](./hackmd-publisher/) | Publishes selected canvas content to HackMD and writes back the URL. | `HMD_API_ACCESS_TOKEN` | `claude`, `copilot` |
| [`html-slides-maker/`](./html-slides-maker/) | Creates static HTML presentations and technical diagrams after confirming the presentation brief. | None | `claude`, `copilot` |
| [`paper-reviewer/`](./paper-reviewer/) | Reviews academic papers and drafts review responses. | None | `claude`, `copilot` |

## Package layout

```text
agent-teams/<team-name>/
  agentlet.yaml        # identity, harness commands, Config schema, and setup requirements
  system_prompt.md     # canonical prompt referenced by require.prompts
  .env.example         # optional standalone-runtime example; Huabu uses managed Configs
  workspaces/          # optional CLI-generated workspaces; ignored by git
```

The source package remains in place. Managed setup materializes only the deployment's configured `workingDirPath`.

## Manifest example

```yaml
schema: agentlet-agent-schema-v1
name: hackmd-publisher
description: Publishes selected canvas content to HackMD

command:
  claude: claude-agent-acp
  copilot: copilot --acp --allow-all

require:
  env:
    - name: HMD_API_ACCESS_TOKEN
      description: HackMD API token used to publish documents
      required: true
      secret: true
  cli-tools:
    - package: '@hackmd/hackmd-cli'
      installer: npm
      scope: shared
      executables:
        - hackmd-cli
  skills:
    - https://github.com/hackmdio/hackmd-cli/tree/develop/hackmd-cli
  prompts:
    - system_prompt.md
```

### CLI tools

Every `require.cli-tools` entry is structured:

| Field | Current values | Meaning |
| --- | --- | --- |
| `package` | npm package identifier | Package passed to npm. |
| `installer` | `npm` | Installer backend. Future backends require an explicit protocol extension. |
| `scope` | `workspace`, `shared` | Install into one deployment workspace or an agentlet-managed store reusable across folders. |
| `executables` | non-empty command list | Commands that must exist before setup and validation can succeed. |

Shared npm tools are isolated by package requirement beneath `~/.agentlet/tools/npm` by default. Set `AGENTLET_SHARED_NPM_TOOLS_DIR` to use another absolute root. Setup checks an exact receipt plus all declared executables before deciding that installation can be skipped, and serializes concurrent installation of the same package requirement.

The runtime prepends both workspace-local and shared npm `.bin` directories to `PATH`. For example, `@hackmd/hackmd-cli` is the npm package while `hackmd-cli` is the executable agents invoke.

### Configs

`require.env` is the source of truth for Huabu's member-level Config UI. Required values gate deployment enablement. Secret values are stored by Huabu's SecretStore and read APIs expose only whether each secret is configured.

The optional `.env.example` remains useful when running a package outside Huabu, but managed deployments receive Config values directly at session spawn and do not require users to create `.env`.

## Optional standalone setup

The generic agentlet CLI remains available for package development and standalone use:

```bash
cd agent-teams/<team-name>
agentlet agent-team setup --harness copilot
agentlet agent-team validate --harness copilot
agentlet agent-team doctor
```

CLI setup defaults the workspace to `workspaces/<harness>/`. Huabu-managed setup instead uses the complete deployment `workingDirPath` selected in Settings.

## Runtime flow

```text
Settings root + machine
        ↓
Agenetes discovery registry
        ↓
member Configs + deployment placement
        ↓ enable/retry
agentlet scan/setup/validate control operations
        ↓
prepared workspace + shared/workspace tool PATH
        ↓
ACP agent session with Huabu Reachback
```

## Related documentation

- [`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md) — generic manifest, setup, workspace, and runtime contract.
- [`docs/architecture/agent-teams-as-extensions.md`](../docs/architecture/agent-teams-as-extensions.md) — current Huabu/Agenetes ownership and topology.
- [`docs/proposals/managed-agent-teams.md`](../docs/proposals/managed-agent-teams.md) — remaining managed Agent Team runtime-service work.
