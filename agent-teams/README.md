# Retained Agent Team Assets

This folder preserves manifest, prompt, Skill and supporting data from the retired Agent Team feature. Huabu no longer scans, registers, prepares or executes these manifests, and neither agentlet nor Agenetes provides the former Team setup/runtime operations. The folders are not copied into the desktop runtime bundle.

These assets remain available as source material for future Space Templates. Keeping them does not imply that old manifest Profiles or Team workload recipes are runnable. The current external-agent implementation is described in [Agent Profiles and Harness Discovery](../docs/architecture/agent-profiles.md).

## Retained packages

| Folder                                         | Content                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| [`deepv-slides-maker/`](./deepv-slides-maker/) | DeepV slide-deck instructions and examples              |
| [`hackmd-publisher/`](./hackmd-publisher/)     | HackMD publication instructions and scripts             |
| [`html-slides-maker/`](./html-slides-maker/)   | HTML slide and diagram instructions                     |
| [`issue-tracker/`](./issue-tracker/)           | Issue coordination prompts, safety contracts and Skills |
| [`paper-reviewer/`](./paper-reviewer/)         | Academic review prompts and supporting material         |
| [`paper-scout/`](./paper-scout/)               | Literature-search and comparison prompts                |

Each folder's `agentlet.yaml` is retained data, not an active execution contract. `system_prompt.md` and `SKILL.md` preserve their canonical references. Standalone Skill installation, where supported by the consuming tool, is separate from Huabu Profile provisioning; Huabu does not install these Skills or inject their old manifest Config values automatically.

User-created `.env` files, historical workspaces and conversation records are not deleted by feature retirement. No replacement setup or migration command is required to use ordinary external Agent Profiles.

## Asset checks

The existing content checks continue to validate the retained Skills and references without running any manifest:

```bash
pnpm run test:agent-team-skills
pnpm run check:agent-team-skills
```

Historical runtime documentation is retained in [the Agent Team archive](../docs/archive/agent-teams-as-extensions.md).
