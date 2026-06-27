# Agent Teams for Huabu

This folder contains **Huabu-managed Agent Teams**: reusable external-agent
packages that Huabu can treat as extensions/plugins.

The generic Agent Team packaging/runtime model lives in:

- [`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md)

This README is only the repo-local outline for how Huabu uses that model.

## What lives here

Each subdirectory under `agent-teams/` is one bundled Agent Team package. In
practice, that usually means:

```text
agent-teams/<team-name>/
  agentlet.yaml
  agent-setup.mjs
  system_prompt.md
  .env.example
  README.md
  ...
```

The exact schema, setup flow, workspaces layout, and runtime contract are
defined in the agentlet spec, not repeated here.

## How Huabu uses Agent Teams

Huabu uses Agent Teams as a managed extension/plugin mechanism:

1. User sets up the package: `node agent-setup.mjs unpack --harness claude`
2. Huabu sends `{ agent_dir, harness }` to the agentlet daemon
3. Daemon reads `agentlet.yaml`, validates the workspace, and spawns the agent
4. The agent uses Huabu Reachback to read/write canvas state

This lets Huabu treat external agents as first-class integrations without
inventing a bespoke plugin API for every service.

## Relationship to the other docs

- [`external/agentlet/spec/agent-team.md`](../external/agentlet/spec/agent-team.md)
  — source of truth for the generic Agent Team feature
- [`docs/agent-teams-as-extensions.md`](../docs/agent-teams-as-extensions.md) — Huabu
  product/vision doc for managed Agent Teams as extensions/plugins

## Examples in this folder

- [`hackmd-publisher/`](./hackmd-publisher/) — publish selected Huabu nodes to
  HackMD

More teams can be added over time as concrete extension patterns emerge.
