# Global Auto-Accept for Agent Space Changes

Status: Accepted — implemented on `fix/issue-175`; set to `Shipped` when merged.
Last updated: 2026-09-11

Issue: [#175](https://github.com/microsoft/Huabu/issues/175)

## 1. Summary

Add a global **Automatically accept Agent Space changes** preference to Settings → General. When enabled, successfully committed Agent-authored Space mutations do not create pending Change Review records, so routine work no longer accumulates `Keep All` actions.

This is a deliberately narrow first step. It preserves the current explicit Keep/Revert workflow when the preference is disabled and preserves the existing in-session Canvas undo behavior, but it does not add durable accepted-change history or promise that an automatically accepted change remains revertible after refresh.

## 2. Problem

Agent-authored Space mutations currently produce per-thread Change Review records with Keep and Revert actions. The common outcome is Keep, so users repeatedly confirm changes that were already validated, authorized, committed, and visible on the Space.

Implementing automatic acceptance by having the Web client click `Keep All` after receiving each update would leave the behavior dependent on an open tab, create avoidable API traffic and races, and briefly expose records that should never have been pending. The decision belongs at the server mutation boundary where review records are created.

The existing Canvas undo stack is not a replacement for durable Revert. It is browser-memory state, retains at most 50 snapshots, may be cleared by reload and selected topology operations, follows chronological local interaction order rather than Agent turns, and may be shadowed by an editor's own undo handling. This proposal therefore describes Ctrl/Cmd+Z only as unchanged best-effort in-session undo.

## 3. Goals

- Let the owner globally disable routine post-application Keep/Revert review for Agent-authored Space mutations.
- Put the preference in the existing Settings → General surface.
- Persist and enforce the preference on the server so it applies without an open Web tab.
- Apply one policy to built-in Agents and thread-attributed external Agents using the shared Canvas executor.
- Preserve existing pending records when the preference changes.
- Keep permission requests and authorization for non-Space side effects unchanged.
- Preserve the existing explicit-review workflow when automatic acceptance is disabled.

## 4. Non-goals

- Durable history for automatically accepted changes.
- Reverting an accepted change after refresh or restart.
- Grouping accepted changes by Agent turn.
- Conflict-aware selective Revert that preserves overlapping later edits.
- Changing the existing Canvas undo/redo architecture.
- Automatically accepting permission requests, commits, pushes, pull requests, issue changes, merges, publication, releases, filesystem operations, memory writes, skill writes, or artifact generation.
- Adding Space-level or Agent Profile-level overrides.
- Repairing existing Change Review inverse, coalescing, retention, or concurrency limitations.

## 5. User experience

Settings → General gains one toggle:

| Property    | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label       | Automatically accept Agent Space changes                                                                                                                                     |
| Description | Do not ask to Keep successful Agent changes to the Space. You can still use Undo during the current session, but accepted changes are not retained for Revert after refresh. |
| Scope       | Global for the Huabu installation                                                                                                                                            |
| Default     | Off                                                                                                                                                                          |

The conservative default preserves existing behavior for upgraded installations and avoids silently removing a recovery surface. A later product decision may change the default for new installations without changing the storage or execution contract.

Changing the toggle affects only future successful Agent mutation batches:

- Turning it on does not delete existing pending Change Review records. Those records remain available for Keep or Revert.
- Turning it off does not reconstruct records for changes that were automatically accepted while the setting was on.
- The UI should not claim that Ctrl/Cmd+Z is durable Revert. It remains the existing current-session chronological Canvas undo.

## 6. Configuration contract

The preference is application-global rather than Space-local because Huabu has no general Space Settings contract today and the immediate product need is one low-friction default for all Agent writers.

Use a dedicated server-owned configuration rather than adding the field to `external-agent-runtime-config.json`, because the preference governs both built-in and external Agents. A representative persisted shape is:

```ts
interface AgentChangeReviewConfig {
  autoAcceptSpaceChanges: boolean;
}
```

Define the wire schema once in `packages/shared/src/types/api/*` and derive its TypeScript type with `z.infer`. The server validates reads and writes against the same schema.

Persist the configuration under Huabu's application data directory using the existing atomic JSON helper. Absence resolves to `{ autoAcceptSpaceChanges: false }`. An unreadable or invalid file is logged and falls back to the conservative default without rewriting the damaged file during a read.

Expose owner-only endpoints:

```text
GET /api/agent-change-review/config
PUT /api/agent-change-review/config
```

Both endpoints require `isOwnerRequest(request)`. The PUT body is validated with `safeParse`; malformed input returns the standard API error body. RFS bearer authentication is not sufficient to modify this configuration, and no Canvas command or Agent tool exposes the setting.

## 7. Server enforcement

The shared Canvas executor remains the policy choke point. After a non-empty Agent batch has passed command validation, authorization, content CAS, execution, and persistence:

```text
successful Agent Canvas batch
  ├─ autoAcceptSpaceChanges = false
  │    compute and persist Change Review records
  └─ autoAcceptSpaceChanges = true
       do not compute or persist Change Review records

Canvas deltas and sync broadcast happen in both cases
```

The effective policy must be read by trusted server code and must not come from tool arguments, `runId`, `threadId`, RFS headers, or other caller-controlled mutation data.

The optimization should prevent review-record computation as well as persistence when automatic acceptance is enabled. Existing callers may continue requesting `computeChanges`; the executor resolves the final policy so built-in, Canvas HTTP, and RFS paths cannot drift.

An all-rejected or no-op batch creates no review record under either mode. A partially accepted command batch follows existing partial-commit semantics: when explicit review is enabled, records describe only the deltas that actually committed; when automatic acceptance is enabled, those committed deltas are applied without pending records.

Only `originator.source === 'agent'` is affected. UI and system mutations continue through their existing paths. Missing or malformed thread attribution remains unrelated to acceptance: an authorized Agent mutation is auto-accepted when the global setting is enabled even when it has no review thread.

## 8. Sync and Web behavior

When automatic acceptance is enabled, the normal Canvas sync event still carries committed deltas and pending effects so every open tab converges and records one existing local undo snapshot where supported. It omits Change Review records because none were created.

Settings → General loads the server configuration when mounted and writes toggle changes through the owner-only API. Use the existing `SettingRow` and `Toggle` components, semantic design tokens, API client helpers, route builders, and localization structure.

Existing Change Review records continue to load and render after automatic acceptance is enabled. This is intentional: changing a global preference must not silently discard previously available Revert actions.

The current pending-review card, question-node conflict indicator, and dirty-node conflict warning remain unchanged for explicit-review records and skipped local writes. Automatic acceptance must not hide dirty-node conflict warnings merely because it suppresses routine review records.

## 9. Authorization boundary

Automatic acceptance occurs only after an Agent Space mutation has already passed the existing command validation and authorization boundary. It changes post-application review bookkeeping, not whether an operation may run.

The preference does not approve or suppress Agent permission requests. It has no effect on commits, pushes, pull requests, issue comments or closure, merges, publication, releases, external filesystem operations, memory or Skill writes, or other side effects outside the Canvas mutation path.

Only the authenticated owner can change the preference. Agent-originated requests, including RFS callers holding the Agentlet connection token, cannot enable it through the Agent mutation surface.

## 10. Persistence and failure behavior

Configuration persistence is independent from a Canvas transaction. A failed settings write leaves the previous server value effective and the General UI restores the last confirmed value with an error toast.

Reading the preference for a Canvas mutation must not turn a configuration I/O failure into a failed Canvas write. The configuration module returns the validated persisted value or the conservative default and logs invalid or unreadable state.

Change Review persistence keeps its existing behavior when explicit review is enabled. This proposal does not change its current best-effort relationship to the already-committed Canvas write.

## 11. Compatibility and migration

No migration of existing Space data is required. The new configuration file is application-global and absent on existing installations, which resolves to automatic acceptance disabled.

Existing per-thread `*.changes.json` files remain valid and are not rewritten or deleted when the preference is enabled. Export and import formats are unchanged because the global setting is installation state rather than Space content.

The feature does not change RFS capability schemas or Agent command schemas.

## 12. Test plan

### Shared contract and configuration

- The schema accepts only `{ autoAcceptSpaceChanges: boolean }`.
- Missing configuration returns the disabled default.
- Valid configuration round-trips through atomic persistence.
- Invalid or unreadable configuration logs and returns the disabled default.
- A failed write preserves the previously persisted value.

### HTTP authorization

- Owner requests can read and update the setting.
- Non-owner requests receive `403`.
- Invalid request bodies receive `400` with the standard API error shape.
- RFS credentials do not provide an alternate path to update the setting.

### Canvas execution

- With the setting off, successful thread-attributed Agent batches keep the current persisted Change Review records and broadcast behavior.
- With the setting on, the same batches commit and broadcast Canvas deltas without computing, persisting, or broadcasting Change Review records.
- Built-in and RFS Agent writes use the same effective setting.
- Unattributed Agent writes follow the setting without treating `runId` or a header as authority.
- UI and system writes are unaffected.
- Rejected and no-op batches create no records.
- Partial command success records only committed deltas when explicit review is enabled.
- Enabling the setting does not delete existing records; disabling it does not create retroactive records.

### Web

- General Settings loads and displays the server value.
- A successful toggle persists and updates the confirmed value.
- A failed toggle restores the previous value and shows an error.
- Existing review cards remain visible after enabling automatic acceptance.
- New auto-accepted sync updates still apply to the Canvas and retain current supported Ctrl/Cmd+Z behavior.
- Permission cards and dirty-edit conflict warnings remain visible and unchanged.
- English and Simplified Chinese localization keys remain in parity.

## 13. Validation

Run focused tests for the shared schema, configuration persistence and route authorization, Canvas executor review branching, and General Settings toggle. Then run the repository-required pre-PR checks:

```bash
pnpm typecheck
pnpm format
pnpm lint:fix
```

Review formatter and linter changes, then rerun affected tests and type checking.

## 14. Deferred follow-up

The complete #175 product direction also asks for bounded, refresh-persistent, conflict-aware history of automatically accepted changes grouped by Agent turn. That requires a durable execution-history model, authoritative selective-revert planning, transactional lifecycle changes, retention, and new history UI.

This proposal intentionally does not claim those guarantees. If persistent Revert remains required after this first step, it should be implemented as a separate reviewed phase rather than inferred from the current browser-memory undo stack.

## 15. Code entry points

| File / dir                                                                                                                             | Responsibility                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`packages/shared/src/types/api/`](../../packages/shared/src/types/api/)                                                               | Add the validated global Agent Change Review configuration contract.                          |
| [`apps/server/src/modules/`](../../apps/server/src/modules/)                                                                           | Own configuration persistence and owner-only GET/PUT routes.                                  |
| [`apps/server/src/modules/security/owner.ts`](../../apps/server/src/modules/security/owner.ts)                                         | Existing owner-recognition policy reused by configuration routes.                             |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                         | Resolve whether a successful Agent batch creates Change Review records.                       |
| [`apps/server/src/modules/storage/backends/disk/space-logs.ts`](../../apps/server/src/modules/storage/backends/disk/space-logs.ts)     | Existing explicit-review record persistence, unchanged when automatic acceptance is disabled. |
| [`apps/web/src/components/Settings/sections/GeneralSettings.tsx`](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Render and persist the global toggle.                                                         |
| [`apps/web/src/components/Panels/ChatPanel/ChangeReviewCard.tsx`](../../apps/web/src/components/Panels/ChatPanel/ChangeReviewCard.tsx) | Continue rendering existing and future explicit-review records.                               |
| [`apps/web/src/store/canvasHistoryManager.ts`](../../apps/web/src/store/canvasHistoryManager.ts)                                       | Existing current-session Canvas undo; explicitly not durable Revert.                          |
| [`docs/architecture/canvas-realtime-sync.md`](../architecture/canvas-realtime-sync.md)                                                 | Update when implementation ships to document conditional review-record creation.              |
| [`docs/architecture/deployment-security.md`](../architecture/deployment-security.md)                                                   | Update when implementation ships to document owner-only configuration access.                 |
