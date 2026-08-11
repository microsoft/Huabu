# Agent Teams for Huabu

This folder contains Huabu-managed Agent Teams: reusable external-agent packages that Huabu discovers, configures, prepares, and runs through Agenetes and connected agentlet daemons.

Each package remains a normal Agent Team defined by the generic [`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md) contract. Huabu adds the managed discovery, Config, Profile, setup, and runtime experience.

Every bundled package is also an installable Agent Skill. The Agent Team manifest and the Skill adapter share one canonical `system_prompt.md`, so installing the package through a standard `skill-add` flow exposes the same capability without registering or launching the Agent Team.

## Quick start

1. Install or run Huabu; the desktop distribution includes this collection and registers it through the locally supervised agentlet automatically.
2. Open **Settings → Agent Teams**.
3. Configure fields marked with a red `(*)`.
4. Expand the member, select a harness, choose the working directory the agent should use, create a Profile, and select **Setup**.

Huabu asks Agenetes to scan the bundled collection, persists the discovered members and Profiles, stores secret Configs in the host SecretStore, and runs package setup through the local daemon. The user-selected Profile working directory is prepared by Setup and later becomes the agent process `cwd`, exactly as `workingDirPath` does for command-backed ACP Profiles. A Profile appears under Agent Teams in Chat and Question Nodes after its member is active, required Configs are complete, and preparation is ready.

## Bundled teams

| Agent                                          | Responsibility                                                                                      | Configs                                         | Harnesses           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------- |
| [`deepv-slides-maker/`](./deepv-slides-maker/) | Creates editable slide decks through a DeepV server.                                                | `DEEPV_SERVER_ENDPOINT`, `DEEPV_SERVER_API_KEY` | `claude`, `copilot` |
| [`hackmd-publisher/`](./hackmd-publisher/)     | Publishes selected Space content to HackMD and writes back the URL.                                 | `HMD_API_ACCESS_TOKEN`                          | `claude`, `copilot` |
| [`html-slides-maker/`](./html-slides-maker/)   | Creates static HTML presentations and technical diagrams after confirming the presentation brief.   | None                                            | `claude`, `copilot` |
| [`issue-tracker/`](./issue-tracker/)           | Coordinates one GitHub issue through an isolated worktree, durable Task, and coding Agent Thread.   | None                                            | `claude`, `copilot` |
| [`paper-reviewer/`](./paper-reviewer/)         | Reviews academic papers and drafts review responses.                                                | None                                            | `claude`, `copilot` |
| [`paper-scout/`](./paper-scout/)               | Quickly finds related arXiv and core HCI venue work and compares its approach with the user's idea. | None                                            | `claude`, `copilot` |

## Package layout

```text
agent-teams/<team-name>/
  agentlet.yaml        # identity, harness commands, Config schema, and setup requirements
  system_prompt.md     # canonical prompt referenced by require.prompts
  SKILL.md             # portable skill discovery and standalone-runtime adapter
  .env.example         # optional standalone-runtime example; Huabu uses managed Configs
  workspaces/          # optional CLI-generated workspaces; ignored by git
```

The source package remains in place. Managed setup materializes only the Profile's configured `workingDirPath`.

## Standalone Skill use

Install an Agent Team package directory with the standard `skill-add` flow. `SKILL.md` declares when the capability should load, points to the canonical package prompt, and resolves bundled scripts and supporting files relative to its own directory.

Packages that require configuration describe the expected fields in `.env.example`. For standalone Skill use, the user provides an untracked `.env` in that package directory, and the Agent loads it before tool calls using an approach appropriate for the runtime operating system and shell. The Skill never initializes `.env`. In managed Agent Team runs, the daemon injects manifest Config values into the process environment instead.

Run the package validator after adding or changing a bundled member:

```bash
pnpm run test:agent-team-skills
pnpm run check:agent-team-skills
```

The validator discovers every direct child with an `agentlet.yaml` and rejects missing Skills, malformed or drifting frontmatter, missing canonical prompts and local references, non-portable paths, and tracked `.env` or generated `workspaces/` state.

## Manifest example

```yaml
schema: agentlet-agent-schema-v1
name: hackmd-publisher
description: Publishes selected Space content to HackMD

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

| Field         | Current values         | Meaning                                                                                  |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `package`     | npm package identifier | Package passed to npm.                                                                   |
| `installer`   | `npm`                  | Installer backend. Future backends require an explicit protocol extension.               |
| `scope`       | `workspace`, `shared`  | Install into one Profile workspace or an agentlet-managed store reusable across folders. |
| `executables` | non-empty command list | Commands that must exist before setup and validation can succeed.                        |

Shared npm tools are isolated by package requirement beneath `~/.agentlet/tools/npm` by default. Set `AGENTLET_SHARED_NPM_TOOLS_DIR` to use another absolute root. Setup checks an exact receipt plus all declared executables before deciding that installation can be skipped, and serializes concurrent installation of the same package requirement.

The runtime prepends both workspace-local and shared npm `.bin` directories to `PATH`. For example, `@hackmd/hackmd-cli` is the npm package while `hackmd-cli` is the executable agents invoke.

### Configs

`require.env` is the source of truth for Huabu's member-level Config UI. Required values gate Profile setup and selection. Secret values are stored by Huabu's SecretStore and read APIs expose only whether each secret is configured.

The optional `.env.example` remains useful when running a package outside Huabu, but managed Profiles receive current Config values whenever a new session spawns and do not require users to create `.env`.

## Optional standalone setup

The generic agentlet CLI remains available for package development and standalone use:

```bash
cd agent-teams/<team-name>
agentlet agent-team setup --harness copilot
agentlet agent-team validate --harness copilot
agentlet agent-team doctor
```

CLI setup defaults the workspace to `workspaces/<harness>/`. Huabu-managed setup instead uses the complete Profile `workingDirPath` selected in Settings.

## Runtime flow

```text
Settings root + machine
        ↓
Agenetes discovery registry
        ↓
member Configs + Profile placement
        ↓ Setup/Retry
agentlet scan/setup/validate control operations
        ↓
prepared workspace + shared/workspace tool PATH
        ↓
ACP agent session with Huabu Reachback
```

## Related documentation

- [`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md) — generic manifest, setup, workspace, and runtime contract.
- [`docs/architecture/agent-teams-as-extensions.md`](../docs/architecture/agent-teams-as-extensions.md) — current Huabu/Agenetes ownership and topology.
- [`docs/proposals/managed-agent-teams.md`](../docs/proposals/managed-agent-teams.md) — unified Profile design and remaining fine-grained Settings event optimization.
