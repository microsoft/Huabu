# Unified External Agent Settings

> Present command-backed ACP Profiles and manifest-backed Agent Team Profiles through one external-agent management and creation experience.
>
> Status: **Shipped** · Last updated: 2026-07-15

---

## 1. Context

Huabu already stores every non-internal agent as one Agenetes Agent Profile union. A command-backed Profile uses `launch.kind = 'acp-command'`; a managed Agent Team Profile uses `launch.kind = 'agent-team-manifest'`. Both kinds share an alias, agentlet placement, and user-selected working directory, and both appear as external bindings at runtime.

The current Settings experience does not reflect that unified model. Ordinary ACP Profiles and managed Agent Team Profiles use separate tabs and separate creation forms, even though selecting a manifest harness is conceptually the same choice as selecting an ACP Agent. This duplicates Profile naming, workspace selection, profile listing, and Chat grouping, and it makes a Template look like a separate kind of user task rather than an optional source of managed capabilities.

This proposal unifies the product surface without erasing the runtime distinction between launch kinds. Template selection becomes an optional field in the existing Profile editor; Agent and harness selection become one field; Template Config and preparation remain conditional managed capabilities.

## 2. Goals

1. Provide one **External Agents** Settings tab for every non-internal Agent Profile.
2. Provide one **Add agent** action and one Profile editor rather than a Template-versus-custom source chooser.
3. Treat a bundled Agent Team member as an optional **Template** that constrains and enriches a Profile.
4. Treat manifest harness IDs and known ACP Agent IDs as the same selection dimension in the UI.
5. Reuse the existing working-directory picker, display-name behavior, CLI detection, and trailing **Custom command** option.
6. Keep Template Config secrets shared by member identity and protected by the existing SecretStore contract.
7. Keep Setup, Retry, and Cancel explicit after manifest-backed Profile creation.
8. Present all selectable external Profiles in one Chat selector group and route Chat's **Add agent** action to Settings.

## 3. Non-goals

- Changing the persisted Agenetes Agent Profile union or external runtime binding model.
- Combining `acp-command` and `agent-team-manifest` into one launch kind.
- Automatically running Setup during Profile creation or first use.
- Adding custom Agent Team roots, remote collections, package installation, or a marketplace.
- Moving secret values into Profile records, setup logs, or web-readable responses.
- Detecting arbitrary commands supplied by untrusted manifests.
- Editing immutable Profile runtime fields after creation.

## 4. Product model

A Profile remains the user-created external-agent configuration. A Template is optional package metadata that supplies supported Agents, Config fields, setup requirements, and a managed runtime command.

```text
Profile
├─ Template (optional Agent Team member)
├─ Agent (known ACP Agent or Template-supported harness)
├─ Template Config (only when a Template is selected)
├─ Working directory
└─ Display name
```

The editor creates an `acp-command` Profile when no Template is selected and an `agent-team-manifest` Profile when a Template is selected. This launch distinction is required by setup and runtime realization, but it does not create two user-facing creation paths.

## 5. Unified Profile editor

### 5.1 Template field

The editor begins with an optional **Template** selector.

- **None** is the default and preserves ordinary ACP Profile creation.
- Each option represents one active bundled Agent Team member, identified by `(agentletId, manifestPath)` and displayed by its manifest name and description.
- Selecting a Template loads its member detail, including supported harnesses and redacted Config state.
- Changing or clearing the Template resets selections and conditional state that are not valid for the new Template.
- Editing an existing Profile remains alias-only because runtime fields are immutable; the Template, Agent, and working directory are shown as read-only context or omitted from the editable section.

### 5.2 Agent field

The editor contains one **Agent** selector. It is the existing ACP Agent selector extended to understand a selected Template; there is no separate Harness control.

Without a Template, the selector shows known ACP Agents in canonical catalog order and appends **Custom command** as its final option. Selecting **Custom command** reveals the raw command input exactly as it does today.

With a Template, the selector shows only the known ACP Agents whose stable IDs occur in the member's `harnesses` list. The selected ID is persisted as `launch.harness`; the manifest remains authoritative for the runtime command. **Custom command** is not offered because an arbitrary command would bypass the Template's setup and runtime contract.

If a Template supports one Agent, the editor selects it automatically. If it supports multiple Agents, the editor preserves manifest order after matching against the canonical Agent catalog.

A bundled manifest that names an unknown Agent ID is invalid for this UI version. The editor displays a clear unsupported-Agent diagnostic and cannot submit that Template selection. Supporting third-party harness catalogs requires a separate trusted catalog design and is outside this proposal.

### 5.3 Config fields

Template Config fields appear only after a Template is selected. They are sourced from the existing member-detail response and retain current behavior:

- non-secret values may be read and replaced;
- secret values expose only configured state and may be replaced or cleared;
- required missing values block Setup and Profile availability;
- values are shared by every Profile with the same `(agentletId, manifestPath)` identity.

Profile creation may save Config changes before creating the Profile. If saving Config succeeds but Profile creation fails, the Config remains saved because it is member-scoped rather than Profile-scoped; the editor reports the Profile error and permits retry.

### 5.4 Working directory and display name

Both launch kinds reuse the existing working-directory picker and absolute-path validation. The bundled package directory is never proposed as a writable default.

Both launch kinds reuse the existing optional display-name input and derived default. The default combines the selected Agent display name with the working-directory basename. A Template may be included in descriptive helper text but does not replace the selected Agent as the naming basis.

### 5.5 Submission

Submission maps the one form into one of the existing Profile create contracts:

```typescript
// No Template selected
{
  alias,
  workingDirPath,
  launch: { kind: 'acp-command', command },
  metadata: { cliId }
}

// Template selected
{
  alias,
  agentletId,
  workingDirPath,
  launch: {
    kind: 'agent-team-manifest',
    manifestPath,
    harness: agentId,
  },
}
```

A manifest-backed Profile is created in `not-prepared` state. Creation never invokes Setup implicitly.

## 6. Agent catalog and detection

### 6.1 One catalog vocabulary

The stable IDs in the existing trusted ACP catalog are the canonical UI vocabulary for Agents. Bundled manifest harness keys must use those IDs, such as `copilot` or `claude`.

The catalog supplies display name, ACP launch recipe, executable probe, auto-approval arguments, and installation guidance. A Template supplies only an allowlist of Agent IDs and the manifest-specific runtime command. The Template does not define a second display or detection catalog.

### 6.2 Reuse the existing detection API

The editor reuses `GET /api/acp/agent-cli` and `detectAgentClis()` rather than adding an Agent Team-specific detection endpoint.

The endpoint changes from returning only installed entries to returning every trusted catalog entry with its existing `installed` boolean. This lets the same Agent selector represent both available and missing Agents without losing the manifest's supported choices.

```text
Trusted ACP catalog ── probe ── Agent + installed state
                                  │
Template harness allowlist ───────┤ filter by stable Agent ID
                                  ▼
                         Unified Agent selector
```

In the current bundled-only scope, Templates run on the locally supervised agentlet, so the existing loopback host probe and execution placement refer to the same machine. Remote agentlet detection would require a machine-scoped detection protocol and is deferred.

### 6.3 Selection behavior

Without a Template, installed known Agents are selectable. Missing known Agents may remain visible with an unavailable state and installation guidance; **Custom command** remains selectable regardless of catalog detection.

With a Template, every supported known Agent remains visible. Installed Agents are selectable. Missing Agents are disabled and display installation guidance. Submission revalidates that the selected Agent is still installed to avoid relying only on stale browser state.

CLI detection is advisory for presentation and create-time validation; it does not replace runtime errors. An executable may disappear after Profile creation, and ACP startup can still fail for authentication, protocol, or process reasons.

## 7. Unified Settings list

The **External Agents** tab renders one Profile list sourced from the unified Profile registry.

Each row shows alias, selected Agent, working directory, and launch-kind context. A small **Template** badge and Template name distinguish manifest-backed Profiles without placing them in a separate section or tab.

Command-backed Profiles retain rename and delete actions. Manifest-backed Profiles additionally show Config readiness and durable preparation state with explicit actions:

```text
not-prepared ── Setup ──▶ setting-up ── success ──▶ ready
                              │
                              ├─ failure ──▶ error ── Retry ──▶ setting-up
                              └─ Cancel ───▶ not-prepared
```

Setup cannot begin while required Config is missing. Profile deletion remains blocked while setup or cancellation is active. Setup logs continue loading on demand rather than becoming part of the lightweight list.

Legacy ACP records that used the removed Agent Team CLI option retain their existing migration notice until deleted; they are not presented as managed Template Profiles.

## 8. Chat integration

Chat retains the built-in Agent separately and renders every selectable non-internal Profile in one **External Agents** group, regardless of launch kind.

Manifest-backed Profiles appear only when member, Config, and preparation availability rules pass. Command-backed Profiles remain available immediately after creation.

Chat's **Add agent** action opens Settings directly on the **External Agents** tab. Chat does not own or launch another Profile editor, which prevents creation behavior from diverging between Settings and Chat.

## 9. API and state changes

The implementation should reuse existing shared wire contracts and keep route ownership task-oriented where useful. No new Profile resource model is required.

Required contract-level changes are:

1. `GET /api/acp/agent-cli` returns all trusted catalog entries, including `installed: false`.
2. The web CLI store retains the complete catalog response rather than interpreting absence as not installed.
3. The existing Agent Team overview and member-detail APIs supply Template choices, harness allowlists, Config fields, Profile preparation, and setup logs.
4. Existing command-Profile and manifest-Profile mutation routes remain the authoritative create paths behind one editor submission handler.
5. Settings open state can request the External Agents tab so Chat can deep-link to it.

Every modified HTTP contract must remain defined once in shared Zod schemas or shared wire types, validate server inputs through the existing API design rules, and keep runtime Zod out of the web bundle.

## 10. Loading, error, and empty states

CLI detection and Template overview load independently. The editor keeps stable placeholders until each required source settles and must not briefly select **Custom command** while detection is pending.

If CLI detection fails, ordinary creation still permits **Custom command** and shows a detection error. Template creation remains blocked until supported Agent installation state can be established because the managed flow cannot safely fall back to a raw command.

If bundled Template discovery is unavailable, ordinary ACP creation remains usable and the Template selector shows a non-blocking unavailable state.

If member detail fails, the selected Template remains visible, its conditional fields show the error with Retry, and submission is disabled until detail loads.

The unified list distinguishes an empty Profile registry from unavailable Template discovery. Users may still create ordinary command-backed Profiles when Templates are unavailable.

## 11. Accessibility and interaction requirements

- Every field has a persistent visible label; descriptions may supplement labels but not replace them.
- Disabled Agent options expose the unavailable reason in adjacent text, not through color alone.
- Setup progress and terminal status are announced through accessible status text.
- Keyboard focus returns to the Add agent trigger when the editor closes.
- Destructive Profile deletion keeps the existing confirmation interaction.
- The implementation uses existing Common components and semantic design tokens.

## 12. Implementation plan

### Phase 1 — Detection contract

- Return the full trusted Agent catalog from the existing CLI detection endpoint.
- Preserve `installed` through the API client and store.
- Add route, detector, and store coverage for installed and missing Agents.

### Phase 2 — One editor

- Extend the existing Profile editor with the optional Template field.
- Reuse the existing Agent, custom command, working-directory, and display-name controls.
- Add Template detail and Config state without introducing a source-selection screen or separate manifest editor.
- Map submission to the existing command-backed or manifest-backed create mutation.

### Phase 3 — One Settings surface

- Replace separate External Agent and Agent Team tabs with one External Agents tab.
- Render one Profile list with conditional Template and preparation affordances.
- Preserve legacy migration notices, lazy setup logs, daemon health messaging, and explicit Setup actions.

### Phase 4 — One Chat surface

- Merge selectable manifest-backed and command-backed Profiles into one External Agents group.
- Route Add agent to the External Agents Settings tab.
- Remove the Chat-owned Profile creation modal.

### Phase 5 — Documentation and cleanup

- Remove superseded split-flow components and translations.
- Update current architecture and package usage documentation after behavior ships.
- Mark this proposal `Shipped`, keep its stable path under `docs/proposals/`, and update the architecture docs to describe the final system.

## 13. Verification

### Server and shared contracts

- CLI detection returns installed and missing known Agents with stable ordering and metadata.
- The endpoint remains loopback-only.
- Manifest Profile creation rejects unknown or unsupported harness IDs through existing registry validation.
- Required Config and preparation availability rules remain unchanged.

### Profile editor

- No Template shows known Agents followed by **Custom command**.
- Selecting **Custom command** is the only condition that reveals the raw command field.
- Selecting a Template filters the same Agent control to its supported harness IDs.
- A single supported installed Agent is selected automatically.
- Missing and unknown Template Agents cannot be submitted and have actionable diagnostics.
- Template Config appears conditionally and secret plaintext is never read back.
- Both launch kinds reuse working-directory and display-name behavior.
- Submission produces the correct existing create payload for each launch kind.
- Editing preserves alias-only semantics.

### Settings and Chat

- One Settings tab and list contain both Profile kinds.
- Setup, Retry, Cancel, logs, deletion guards, and readiness states remain correct for manifest Profiles.
- Command Profiles never display preparation actions.
- Chat renders one External Agents group and only includes available Profiles.
- Add agent opens the correct Settings tab.
- English and Chinese translation keys remain in parity.

### Regression checks

- Existing durable thread bindings and Profile snapshots remain unchanged.
- Ordinary custom-command creation works when no known CLI is installed.
- Bundled Template discovery failure does not disable ordinary ACP Profile management.
- The web typecheck, focused Vitest suites, ESLint, i18n parity check, server tests, and package build pass.

## 14. Risks and mitigations

| Risk                                               | Mitigation                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness IDs and ACP catalog IDs drift              | Declare the trusted ACP Agent ID as the UI contract, validate bundled manifests in tests, and block unknown IDs with a diagnostic.            |
| Host detection differs from runtime placement      | Limit this proposal to the bundled local-agentlet scope and defer machine-scoped detection. Runtime startup remains authoritative.            |
| One form becomes visually dense                    | Reveal Config only after Template selection and preparation controls only after creation. Keep shared Profile fields in their existing order. |
| Config save succeeds before Profile creation fails | Treat Config as intentionally member-scoped, report the Profile error, and permit retry without rolling back shared Config.                   |
| Existing WIP preserves two creation paths          | Remove the source chooser and separate manifest editor; acceptance tests begin from one Add agent action and one editor.                      |
| Returning missing CLIs changes existing consumers  | Update consumers to filter intentionally where needed and test full-catalog ordering and disabled states.                                     |

## 15. Acceptance criteria

The proposal is complete when all of the following are true:

1. Settings contains one External Agents tab and one Add agent action.
2. Add agent opens one editor whose Template field is optional.
3. The editor contains one Agent selector and never displays a second Harness selector.
4. No Template creates an `acp-command` Profile; a Template creates an `agent-team-manifest` Profile.
5. The existing detection endpoint supplies installed state for all trusted Agents and no Agent Team-specific detection endpoint exists.
6. Template Config is conditional and secrets retain redacted shared storage behavior.
7. Working directory and display naming use the same controls and rules for both Profile kinds.
8. Manifest Profile creation does not start Setup; the unified list exposes explicit Setup, Retry, and Cancel.
9. Chat presents one External Agents group and sends Add agent to Settings.
10. Existing Profile persistence, thread bindings, runtime snapshots, and setup semantics do not change.

## 16. Related documents

- [`managed-agent-teams.md`](./managed-agent-teams.md) — unified Agenetes Profile registry, managed discovery, preparation, and runtime design.
- [`../architecture/agent-teams-as-extensions.md`](../architecture/agent-teams-as-extensions.md) — current shipped Agent Team product and ownership boundaries.
- [`../architecture/api-design.md`](../architecture/api-design.md) — shared-contract and endpoint requirements.
- [`../architecture/web-architecture.md`](../architecture/web-architecture.md) — frontend ownership and component conventions.
- [`../../agent-teams/README.md`](../../agent-teams/README.md) — bundled Template manifests and current usage.
- [`../../external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md) — generic Agent Team package contract.
