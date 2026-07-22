# Agent Submission and Input Boundary

> Status: **Shipped**
>
> Last updated: 2026-07-12

> Current architecture: [agent-architecture.md](../architecture/agent-architecture.md) and [Agenetes README](../../external/agenetes/README.md)

## 1. Summary

Replace Agenetes' current `AgentRequest` with one generic, backward-compatible `AgentSubmission`:

```ts
export interface AgentSubmission<
  TSource = unknown,
  TType extends string = string,
> {
  readonly type: TType;
  readonly content: TSource;
  readonly rendered?: readonly AgentInput[];
}
```

`type` and `content` preserve the existing durable request shape. `rendered`, when present, is the ordered canonical input sequence that the agent harness should consume. One UI submission may render into zero, one, or many canonical input members while remaining one agent turn.

`rendered` is permanently optional, not merely optional for migration. Its absence means the handle applies the protocol's generic content fallback:

```text
string content -> one verbatim AgentTextInput
other content  -> one JSON AgentTextInput
```

An explicitly present empty array means zero inputs and must not trigger fallback.

Huabu supplies `rendered` through stable host renderers before calling the handle. The behavior-preserving migration may keep separate internal and external adapters that both produce `AgentInput[]`; converging them into one shared host renderer is a final best-effort cleanup rather than a prerequisite. `AgentHandle.run()` receives the complete submission and never receives a render function.

`AgentHandle.run(null, ctx)` remains valid and means no new submission. It bypasses input resolution and keeps the existing driver-defined resume-without-input semantics.

The complete submission is persisted in the existing `request` position in Tier 1 and Tier 2. Recovery and fork consume stored `rendered` inputs when available and use the same generic content fallback when they are absent.

## 2. Problem

The current `AgentHandle.run(request, render, ctx)` seam combines two different boundaries:

```text
L1 -> L2
structured UI information
durable source for history and host projections

L2 -> harness
ordered text/image/command inputs
durable source for recovery and fork
```

The existing `AgentRequest { type, content }` preserves only the first representation. A driver invokes a caller-supplied renderer on every turn to obtain backend-native input, so the generic handle simultaneously acts as a logging boundary, rendering boundary, and harness execution boundary.

Consequences include:

1. Every upper-layer turn passes a renderer even when request semantics are stable.
2. Backend-native rendered types leak into the generic handle signature.
3. Drivers see host request variants such as `huabu.chat`.
4. Recovery and fork cannot reconstruct the original harness input without running a renderer again.
5. `AgentTurnState` crosses back into host rendering to support backend lifecycle details such as ACP's one-shot preamble.

## 3. Goals

1. Preserve the existing `{ type, content }` source shape and outer logging format.
2. Add an optional ordered canonical input sequence to the same submission.
3. Give internal and external Huabu agents the same canonical `AgentInput[]` output contract, enabling a later shared renderer.
4. Remove renderer functions and backend-native rendered generics from `run()`.
5. Let recovery and fork consume durable canonical inputs without re-rendering new turns.
6. Give submissions without `rendered` a universal text fallback.
7. Keep harness-facing input free of canvas, binding, logging, and host-source concepts.
8. Carry portable initial-preamble data through `WorkloadSpec` without prescribing how a driver realizes it in its backend.
9. Represent slash commands explicitly so preamble handling does not parse native messages.

## 4. Non-goals

This proposal does not expose handle state to request renderers.

This proposal does not require pi and ACP to use the same backend-native message format.

This proposal does not persist backend-native pi messages or ACP blocks.

This proposal does not optimize the storage size of base64 image parts. Replacing inline image data with durable artifact references is a separate follow-up.

This proposal does not reproduce the historical renderer output for old records that lack `rendered`; those records intentionally use the generic content fallback.

This proposal does not define one universal backend role, delivery point, or lifecycle algorithm for `WorkloadSpec.initialPreamble`.

## 5. Protocol contracts

### 5.1 `AgentSubmission`

`AgentSubmission` is generic over source content and optionally preserves a literal type:

```ts
export interface AgentSubmission<
  TSource = unknown,
  TType extends string = string,
> {
  readonly type: TType;
  readonly content: TSource;
  readonly rendered?: readonly AgentInput[];
}
```

A host may use a discriminated union:

```ts
type HuabuSubmission = AgentSubmission<ChatEnvelope, 'huabu.chat'>;
```

A host with only one source shape may still keep a constant `type`; Agenetes does not dispatch on it. The discriminant remains useful for durable inspection, host projections, and future host-side variants.

The run seam accepts `AgentSubmission | null`:

```ts
run(
  submission: AgentSubmission<TSource, TType> | null,
  ctx: TTurnCtx,
): AsyncGenerator<TEvent, TResult>;
```

`null` is not an empty submission and does not invoke `resolveAgentInputs()`. It preserves the existing protocol meaning of “no new input this turn”; the driver may resume preloaded state, reject the operation, or otherwise apply its documented backend behavior. Tier-1 and Tier-2 logging continue to preserve `request: null` for such turns.

The current `AgentRequest` is exactly the subset without `rendered`, so `AgentSubmission` replaces it rather than extending it through a second nested object:

```ts
type LegacyAgentRequest<TSource = unknown> = Omit<
  AgentSubmission<TSource>,
  'rendered'
>;
```

### 5.2 `AgentInput`

`AgentInput` is one member of the canonical harness input sequence:

```ts
export type AgentInput = AgentTextInput | AgentPartsInput | AgentCommandInput;

export interface AgentTextInput {
  readonly type: 'text';
  readonly text: string;
}

export interface AgentPartsInput {
  readonly type: 'parts';
  readonly parts: readonly AgentInputPart[];
}

export interface AgentCommandInput {
  readonly type: 'command';
  /** The complete command line, preserved verbatim. */
  readonly text: string;
  /** Selection, attachments, and other context appended after the command. */
  readonly context: readonly AgentInputPart[];
}

export type AgentInputPart =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'image';
      readonly data: string;
      readonly mimeType: string;
    };
```

If `rendered` contains an `AgentCommandInput`, that command must be its only top-level member. Selection, attachments, and other command-associated material belong in `AgentCommandInput.context`; a command must not be mixed with ordinary top-level inputs or with another command in the same submission.

`AgentInput` contains no source discriminant, canvas id, ACP profile binding, namespace, logger, abort signal, or turn metadata.

The current server-local `ContentPart[]` already matches the text/image portion of this vocabulary and should be promoted rather than reimplemented.

### 5.3 Generic content fallback

The handle resolves the canonical sequence mechanically:

```ts
function resolveAgentInputs(
  submission: AgentSubmission,
): readonly AgentInput[] {
  if (submission.rendered !== undefined) {
    return submission.rendered;
  }

  if (typeof submission.content === 'string') {
    return [{ type: 'text', text: submission.content }];
  }

  const text = JSON.stringify(submission.content);
  if (text === undefined) {
    throw new Error('Agent submission content is not JSON serializable');
  }

  return [{ type: 'text', text }];
}
```

Resolution tests field presence, not array length. `rendered: []` is an explicit empty sequence.

This fallback is protocol normalization, not host prompt rendering. It does not inspect `submission.type`, invoke a registry, or understand `ChatEnvelope`.

## 6. Host rendering before `run()`

Rendering is a pure host operation outside the Agenetes contract. Agenetes constrains only the serializable `rendered: AgentInput[]` result; it does not define renderer signatures, dependency injection, registries, or execution context.

```ts
const rendered = await renderInternalEnvelope(envelope, {
  canvasId,
  logger,
  // Any other host-owned rendering dependency.
});
```

An ordinary call then becomes:

```ts
const submission: HuabuSubmission = {
  type: 'huabu.chat',
  content: envelope,
  rendered,
};

handle.run(submission, turnContext);
```

No function is passed to `run()`. An exceptional caller overrides rendering by constructing a different `rendered` sequence. A renderer may read canvas id, binding metadata, logger, files, caches, or any other host-owned context; none of those dependencies enters the Agenetes interface unless the host deliberately includes their result in `content` or `rendered`.

The existing `defineRequest()` / `composeRequest()` helpers are unnecessary for Huabu and should be removed with `AgentRequest`. A future host that wants renderer dispatch may implement it entirely above the submission contract.

If host rendering fails, no submission reaches `run()` and no Tier-1 turn starts. If the caller wants the generic fallback instead, it omits `rendered`.

## 7. Optional convergence to one Huabu renderer

Both routes already build the same `ChatEnvelope`, and both already delegate most prompt composition to the same `renderTurn()` function. The initial migration should retain two stable host adapters so it does not need to solve every wording and command difference at the same time as the protocol boundary:

```text
internal: ChatEnvelope -> renderTurn(INTERNAL_PROFILE) -> AgentInput[]
external: ChatEnvelope -> renderTurn(ACP_PROFILE)      -> AgentInput[]
```

These adapters are selected before `run()` and are not passed as per-turn functions. Their outputs share the same durable canonical type, so logging, recovery, fork, handle policy, and driver lowering are already unified.

After parity is established, a best-effort cleanup may converge them. The shared function may still accept arbitrary host context:

```text
ChatEnvelope + host render context
  -> renderChatEnvelope()
  -> AgentInput[]
  -> AgentSubmission { type, content, rendered }
       |-> pi lowerInputs()  -> Message[]
       `-> ACP lowerInputs() -> ACP content blocks
```

The eventual shared `renderChatEnvelope()` performs slash-command recognition once:

```ts
async function renderChatEnvelope(
  envelope: ChatEnvelope,
  context: HuabuRenderContext,
): Promise<readonly AgentInput[]> {
  const parts = await renderTurn(envelope, context);

  if (isSlashCommand(envelope.user.text)) {
    return [
      {
        type: 'command',
        text: envelope.user.text,
        context: partsWithoutUserText(parts),
      },
    ];
  }

  return [
    parts.length === 1 && parts[0].type === 'text'
      ? { type: 'text', text: parts[0].text }
      : { type: 'parts', parts },
  ];
}
```

The renderer may return multiple `AgentInput` members when one UI envelope naturally contains multiple input units. Those members remain part of one submission and do not independently create backend turns.

Convergence requires the current internal/reachback profile wording to become neutral request wording or move into the portable initial preamble data that describes the available tool surface. A driver may realize that data through a harness-native instruction mechanism; driver lowering must not select Huabu prompt wording.

Failure to converge the two host adapters does not compromise the new protocol boundary. It leaves a small host-level rendering variation while preserving all submission and lifecycle invariants.

ACP binding remains `{ alias, profileId }`; canvas-scoped session isolation remains in `WorkloadSpec.namespace`; reachback remains in `WorkloadSpec.env`. A host renderer may also read any of these values when producing canonical input, but Agenetes neither requires nor interprets that dependency.

## 8. Portable initial preamble data

Add a portable text-only member to `WorkloadSpec`:

```ts
interface WorkloadSpec {
  readonly initialPreamble?: readonly string[];
}
```

`initialPreamble` is an ordered list of portable, host-authored text fragments. It transports instruction content across the protocol boundary; it is not itself a backend-native system-role message, a sequence of user messages, or a directive to prepend text to the first user input.

The array form lets the host compose independently owned sections such as agent identity, tool policy, and canvas-access guidance without requiring every caller to rebuild one monolithic string. An empty or absent array means no preamble.

The driver owns the mapping from this portable data to its backend. Drivers should prefer the harness-native mechanism that most faithfully represents persistent agent instructions, such as a system/developer prompt, agent configuration, or native context update. This preserves backend instruction priority, session semantics, and runtime update behavior instead of forcing every harness through user-message text.

When a backend has no suitable native instruction mechanism, a driver may use first-ordinary-message prefixing as a fallback. For example, it may join the fragments with `\n\n`, prepend the result to the first non-command `AgentInput`, and mark delivery only after that backend input succeeds.

```ts
const preamble = spec.initialPreamble?.join('\n\n') ?? '';
const effectiveInputs =
  preamblePending && preamble !== ''
    ? prependToFirstOrdinaryInput(preamble, inputs)
    : inputs;
```

The prefix strategy above is illustrative, not protocol behavior. The protocol and generic runtime do not join fragments, choose a backend role, track `preamblePending`, interpret command ordering, or define when delivery is complete. A driver that requires one-shot delivery state owns that decision and reports it through the shared durable snapshot:

```ts
interface AgentStateSnapshot {
  readonly sessionId?: SessionId;
  readonly metadata?: AgentMetadata;
  readonly initialPreambleDelivered?: boolean;
}
```

`initialPreambleDelivered` means the driver considers its backend-specific realization of the current workload's preamble complete. A driver that can reinstall native instructions deterministically when creating or resuming a handle may omit the field. A driver with one-shot delivery sets it only after successful realization, persists it through the normal state up-report path, and restores it on native session resume. The presence of `sessionId` alone never implies that preamble delivery completed.

On recovery or fork, the target driver realizes the target workload's `initialPreamble` through the same backend-specific policy it uses for a fresh workload. Stored submissions do not carry the source workload's preamble policy into the target workload.

## 9. Command handling

A command occupies the complete top-level canonical sequence for its submission. Its command line remains leading content, while selection, attachments, and other related material follow inside `context`. Protocol validation rejects a `rendered` array that mixes a command with ordinary inputs or contains multiple commands.

A command-only sequence does not consume pending preamble state in a driver using that fallback. ACP lowering emits command text as the first content block and appends `context`; a harness without native command semantics may lower it to an ordinary message whose first line remains the command.

The driver switches on `AgentInput.type`; it never reparses slash syntax from backend-native messages.

## 10. Harness lowering

Each driver owns the exhaustive conversion from the ordered canonical sequence into native input and the realization of portable workload policy such as `initialPreamble`:

```ts
type LowerInputsFn<TNativeInput> = (
  inputs: readonly AgentInput[],
) => TNativeInput | Promise<TNativeInput>;
```

The standard lowerings are:

```text
AgentTextInput    -> pi user Message / ACP text block
AgentPartsInput   -> pi content parts / ACP content blocks
AgentCommandInput -> leading command plus trailing context
```

Input lowering preserves order and does not inspect `submission.type`, `submission.content`, `ChatEnvelope`, canvas id, ACP binding, namespace, or Huabu render profiles. Preamble realization reads `WorkloadSpec.initialPreamble` independently and uses the most appropriate backend-native mechanism.

One `run(submission, ctx)` represents one agent turn and must not become multiple backend turns merely to preserve boundaries between `AgentInput` members. A driver may preserve those boundaries when its harness accepts multiple messages atomically in one turn, as pi does. Otherwise it should flatten the members in order into one backend input, as ACP does with one ordered content-block submission.

The protocol therefore guarantees member order and the enclosing submission/turn boundary, but it does not guarantee that every `AgentInput` member survives as a distinct backend-native message.

## 11. Logging, recovery, and fork

Keep the existing outer log field and persist the complete submission:

```text
beginTurn(submission)
  -> resolve rendered or generic fallback inputs
  -> driver preamble realization and command lowering
  -> execute harness
  -> append and fold AgentStreamEvents
  -> append AgentTurn { request: submission, transcript, meta }
```

Old Tier-1 and Tier-2 records already contain `{ type, content }` in `request`; they parse as submissions with `rendered === undefined`. New records add only the optional `rendered` field.

Recovery and fork call `resolveAgentInputs(turn.request)`:

- New records normally use their stored ordered canonical inputs.
- Old records use verbatim string content or JSON-stringified structured content.
- An explicit `rendered: []` remains an empty input sequence.

The target driver realizes the target workload's `initialPreamble` separately, so a fork does not carry source-agent preamble text or realization state into the target agent.

Backend-native input is never persisted. Base64 inside canonical `AgentInputPart` is persisted as-is in this scope.

## 12. Ownership table

| Value                          | Lifetime                       | Owner                     | Consumer                            |
| ------------------------------ | ------------------------------ | ------------------------- | ----------------------------------- |
| `AgentSubmission.type/content` | one turn, durable              | host source model         | host history and projections        |
| `AgentSubmission.rendered`     | one turn, durable when present | host renderer             | recovery, fork, and driver lowering |
| generic content fallback       | per resolution                 | Agenetes protocol/runtime | submissions without `rendered`      |
| `WorkloadSpec.initialPreamble` | workload                       | host policy               | driver-specific backend realization |
| preamble delivered state       | driver session, durable        | driver                    | native resume and one-shot fallback |
| backend-native input           | one execution                  | driver                    | pi harness or ACP session           |
| `AgentStreamEvent`             | one running turn               | driver translation        | live clients and durable fold       |

## 13. Implementation stages

### Stage 1: Protocol vocabulary

1. Replace `AgentRequest` with generic `AgentSubmission<TSource, TType>`.
2. Replace the current `{ message: string }` `AgentInput` with text, parts, and command members.
3. Add `resolveAgentInputs()` with presence-based fallback semantics.
4. Reject canonical sequences that mix a command with other top-level inputs.
5. Add optional `initialPreambleDelivered` to the shared durable agent-state snapshot.
6. Remove `defineRequest()` / `composeRequest()` and their conformance-only tests.
7. Extend `AgentTurn.request` to the submission schema with optional `rendered`.

### Stage 2: Behavior-preserving Huabu adapters

1. Promote server-local `ContentPart` to `AgentInputPart`.
2. Adapt `INTERNAL_PROFILE` output to canonical `AgentInput[]`.
3. Adapt `ACP_PROFILE` / `ACP_SLASH_PROFILE` output to canonical `AgentInput[]`.
4. Emit `AgentCommandInput` for leading slash commands.
5. Construct complete submissions before calling either driver.

### Stage 3: Handle and driver boundary

1. Change `AgentHandle.run()` to `run(submission, ctx)`, retaining nullable submission semantics.
2. Change `turn_start` and Tier-2 logging to preserve the complete submission.
3. Remove `RenderFn`, `TRendered`, and `AgentTurnState` from the public run seam.
4. Add exhaustive pi and ACP sequence lowering.
5. Remove per-run render closures and Huabu wrap/unwrap helpers.

### Stage 4: Driver preamble realization

1. Add ordered text-fragment `initialPreamble` to the shared workload contract.
2. Map it through each driver's preferred harness-native instruction mechanism where available.
3. Use first-ordinary-message prefixing only as a driver fallback when the backend lacks a suitable native mechanism.
4. Up-report `initialPreambleDelivered` after successful one-shot realization and restore it during native session resume without inferring it from `sessionId`.

### Stage 5: Best-effort renderer convergence

1. Compare internal and external canonical inputs for equivalent envelopes.
2. Neutralize or relocate tool-surface-specific wording.
3. Replace the two stable adapters with one `renderChatEnvelope()` only when prompt and attachment parity is demonstrated.

The shipped implementation shares the canonical `renderTurn()` composition and attachment primitives while retaining thin internal and external adapters. Their remaining differences are intentional backend policy: the internal profile names built-in tools, the external profile describes reachback, and ACP slash commands require an exclusive `AgentCommandInput`. No second host-side ACP wire or preamble renderer remains.

## 14. Validation

The implementation must cover:

1. Old `{ type, content }` records parse with `rendered === undefined`.
2. New records preserve `type`, `content`, and ordered `rendered` inputs unchanged.
3. Missing `rendered` uses verbatim string content or one JSON text input.
4. `rendered: []` does not trigger fallback.
5. Internal and external adapters both produce valid ordered `AgentInput[]`.
6. One envelope may render into multiple ordered canonical input members without creating multiple backend turns.
7. Text and image parts lower equivalently to current pi and ACP payloads.
8. Rendering failure before `run()` creates no turn; execution failure after `run()` starts leaves an incomplete turn containing the submission.
9. Each driver realizes `initialPreamble` through its documented backend policy, preferring a harness-native instruction mechanism where available.
10. A driver using the prefix fallback joins multiple fragments in order with one blank line between fragments.
11. A failed ordinary submission does not consume pending preamble state in a driver using the prefix fallback.
12. Command-only input remains first and does not consume pending preamble state in a driver using the prefix fallback.
13. Recovery and fork use stored `rendered` inputs without host rendering.
14. Target preamble policy is applied independently from stored inputs.
15. Inline base64 image parts round-trip without storage optimization.
16. ACP namespace/session isolation and reachback remain independent of rendering.
17. If renderer convergence is performed, parity tests prove equivalent prompt and attachment behavior before deleting either adapter.
18. A driver preserves `AgentInput` member order, uses one backend turn per submission, and flattens members when its harness cannot accept multiple messages atomically.
19. Protocol validation rejects command-plus-ordinary and multiple-command top-level sequences.
20. Native session resume restores `initialPreambleDelivered`; a persisted `sessionId` without that flag does not suppress one-shot preamble realization.
21. `run(null, ctx)` bypasses input resolution, preserves `request: null` in the turn log, and retains driver-defined resume-without-input behavior.

## 15. Expected code entry points

| File                                                                                                                                           | Responsibility                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`external/agenetes/packages/protocol/src/request.ts`](../../external/agenetes/packages/protocol/src/request.ts)                               | `AgentSubmission`, `AgentInput`, fallback normalization |
| [`external/agenetes/packages/protocol/src/turn.ts`](../../external/agenetes/packages/protocol/src/turn.ts)                                     | Durable submission on each folded turn                  |
| [`external/agenetes/packages/protocol/src/workload.ts`](../../external/agenetes/packages/protocol/src/workload.ts)                             | Ordered portable text-fragment `initialPreamble`        |
| [`external/agenetes/packages/protocol/src/agent-state.ts`](../../external/agenetes/packages/protocol/src/agent-state.ts)                       | Durable preamble-delivery state                         |
| [`external/agenetes/packages/runtime/src/handle.ts`](../../external/agenetes/packages/runtime/src/handle.ts)                                   | `run(submission, ctx)` execution seam                   |
| [`external/agenetes/packages/pi-driver/src/handle.ts`](../../external/agenetes/packages/pi-driver/src/handle.ts)                               | Native preamble realization and pi sequence lowering    |
| [`external/agenetes/packages/acp-driver/src/handle.ts`](../../external/agenetes/packages/acp-driver/src/handle.ts)                             | Preamble realization, commands, ACP sequence lowering   |
| [`external/agenetes/packages/agenetes/src/instance.ts`](../../external/agenetes/packages/agenetes/src/instance.ts)                             | Logging decoration over complete submissions            |
| [`external/agenetes/packages/agenetes/src/event-log.ts`](../../external/agenetes/packages/agenetes/src/event-log.ts)                           | Tier-1 `turn_start` submission persistence              |
| [`external/agenetes/packages/agenetes/src/materialize-history.ts`](../../external/agenetes/packages/agenetes/src/materialize-history.ts)       | Complete and incomplete turn materialization            |
| [`apps/server/src/modules/agent/conversation/envelope.ts`](../../apps/server/src/modules/agent/conversation/envelope.ts)                       | Huabu source content                                    |
| [`apps/server/src/modules/agent/conversation/prompt/build-prompt.ts`](../../apps/server/src/modules/agent/conversation/prompt/build-prompt.ts) | Canonical adapters and eventual shared renderer         |
| [`apps/server/src/modules/agent/agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts)                                       | Internal submission construction                        |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                                           | External submission construction                        |
