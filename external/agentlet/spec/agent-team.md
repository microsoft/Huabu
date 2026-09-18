# Historical Agent Team manifest data

Status: Retired runtime; retained data reference.

Agent Team folders and `agentlet.yaml` files may remain as authored data. Agentlet no longer parses, scans, sets up, validates, or launches those manifests. The `@agentlet/agent-team` runtime package, `agentlet agent-team` CLI, `agent-team/*` RPCs, setup workers, and `SessionSpec.agentTeam` resolution have been removed.

Current generic discovery and ACP spawning are specified in [protocol.md](protocol.md). The daemon's trusted static harness catalogue is independent of Team manifests; it never reads manifest commands, requirements, prompts, skills, or credentials.

## Historical authored layout

```text
<agent-team>/
  agentlet.yaml
  system_prompt.md
  .env.example
  skills/
  scripts/
  assets/
```

These folders are preserved data, not installed packages or prepared deployments.

## Historical manifest shape

```yaml
schema: agentlet-agent-schema-v1
name: example
description: An authored agent package
command:
  copilot: copilot --acp
require:
  prompts:
    - system_prompt.md
  skills:
    - ./skills/example
  env:
    - name: EXAMPLE_TOKEN
      description: External service token
      required: true
      secret: true
```

The historical manifest could declare `command` mappings, `require.cli-tools`, `require.prompts`, `require.skills`, `require.env`, `require.copies`, and `onInstall`. These fields are reference data only; they do not authorize package installation, filesystem copying, script execution, or credential provisioning by the current daemon.

## Current code entry points

| Contract | Source |
| --- | --- |
| Generic harness catalogue | [`catalogue.ts`](../packages/local/src/harnesses/catalogue.ts) |
| Read-only discovery and optional workspace preparation | [`detect.ts`](../packages/local/src/harnesses/detect.ts) |
| Generic spawn contract | [`messages.ts`](../packages/protocol/src/messages.ts) |
