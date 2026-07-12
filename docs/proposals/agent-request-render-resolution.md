# Agent Submission and Input Boundary

> Status: **Draft**
>
> Last updated: 2026-07-12

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

`type` and `content` preserve the existing durable request shape. `rendered`, when present, is the ordered canonical input sequence that the agent harness should consume. One UI submission may render into zero, one, or many agent messages.

`rendered` is permanently optional, not merely optional for migration. Its absence means the handle applies the protocol's generic content fallback:

```text
string content -> one verbatim AgentTextInput
other content  -> one JSON AgentTextInput
```

An explicitly present empty array means zero inputs and must not trigger fallback.

Huabu supplies `rendered` through stable host renderers before calling the handle. The behavior-preserving migration may keep separate internal and external adapters that both produce `AgentInput[]`; converging them into one `ChatEnvelope -> AgentInput[]` renderer is a final best-effort cleanup rather than a prerequisite. `AgentHandle.run()` receives the complete submission and never receives a render function.

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
8. Move first-message preamble delivery into handle lifecycle state.
9. Represent slash commands explicitly so preamble handling does not parse native messages.

## 4. Non-goals

This proposal does not make ACP binding or namespace part of request rendering.

This proposal does not expose handle state to request renderers.

This proposal does not require pi and ACP to use the same backend-native message format.

This proposal does not persist backend-native pi messages or ACP blocks.

This proposal does not optimize the storage size of base64 image parts. Replacing inline image data with durable artifact references is a separate follow-up.

This proposal does not reproduce the historical renderer output for old records that lack `rendered`; those records intentionally use the generic content fallback.

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

The current `AgentRequest` is exactly the subset without `rendered`, so `AgentSubmission` replaces it rather than extending it through a second nested object:

```ts
type LegacyAgentRequest<TSource = unknown> = Omit<
  AgentSubmission<TSource>,
  'rendered'
>;
```

### 5.2 `AgentInput`

`AgentInput` is one canonical harness message:

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

## 6. Rendering before `run()`

Huabu defines one stable renderer:

```ts
type HuabuRenderer = (
  envelope: ChatEnvelope,
) => readonly AgentInput[] | Promise<readonly AgentInput[]>;
```

An ordinary call becomes:

```ts
const submission: HuabuSubmission = {
  type: 'huabu.chat',
  content: envelope,
  rendered: await renderChatEnvelope(envelope),
};

handle.run(submission, turnContext);
```

No function is passed to `run()`. An exceptional caller overrides rendering by constructing a different `rendered` sequence.

The existing `defineRequest()` / `composeRequest()` helpers are unnecessary for Huabu and should be removed with `AgentRequest`. A future host that wants renderer dispatch may implement it entirely above the submission contract.

If host rendering fails, no submission reaches `run()` and no Tier-1 turn starts. If the caller wants the generic fallback instead, it omits `rendered`.

## 7. Optional convergence to one Huabu renderer

Both routes already build the same `ChatEnvelope`, and both already delegate most prompt composition to the same `renderTurn()` function. The initial migration should retain two stable host adapters so it does not need to solve every wording and command difference at the same time as the protocol boundary:

```text
internal: ChatEnvelope -> renderTurn(INTERNAL_PROFILE) -> AgentInput[]
external: ChatEnvelope -> renderTurn(ACP_PROFILE)      -> AgentInput[]
```

These adapters are selected before `run()` and are not passed as per-turn functions. Their outputs share the same durable canonical type, so logging, recovery, fork, handle policy, and driver lowering are already unified.

After parity is established, a best-effort cleanup may converge them:

```text
ChatEnvelope
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
): Promise<readonly AgentInput[]> {
  const parts = await renderTurn(envelope);

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

The renderer may return multiple `AgentInput` members when one UI envelope needs multiple user-message boundaries.

Convergence requires the current internal/reachback profile wording to become neutral request wording or move into the portable initial preamble that describes the available tool surface. Driver lowering must remain mechanical and must not select Huabu prompt wording.

Failure to converge the two host adapters does not compromise the new protocol boundary. It leaves a small host-level rendering variation while preserving all submission and lifecycle invariants.

`ChatEnvelope` should carry the `canvasId` already known by `buildChatEnvelope()` so attachment resolution does not rely on a per-turn closure.

ACP binding remains `{ alias, profileId }`; canvas-scoped session isolation remains in `WorkloadSpec.namespace`; reachback remains in `WorkloadSpec.env`. None of these values enters `renderChatEnvelope()`.

## 8. Portable initial preamble

Add a portable text-only member to `WorkloadSpec`:

```ts
interface WorkloadSpec {
  readonly initialPreamble?: readonly string[];
}
```

`initialPreamble` is an ordered list of portable text fragments, not backend-native system-role messages and not multiple user messages. The handle joins the fragments with `\n\n` and prepends the resulting text to the first ordinary canonical input.

The array form lets the host compose independently owned sections such as agent identity, tool policy, and canvas-access guidance without requiring every caller to rebuild one monolithic string. An empty or absent array means no preamble.

The handle tracks delivery independently from native session message count:

```ts
class AgentHandle {
  private preamblePending = (this.spec.initialPreamble?.length ?? 0) > 0;
}
```

After resolving submission inputs, the handle prepends to the first non-command member:

```ts
const inputs = resolveAgentInputs(submission);
const preamble = this.spec.initialPreamble?.join('\n\n') ?? '';
const effectiveInputs = this.preamblePending
  ? prependToFirstOrdinaryInput(preamble, inputs)
  : inputs;

const result = await this.runInputs(effectiveInputs, ctx);
if (containsOrdinaryInput(effectiveInputs)) {
  this.preamblePending = false;
}
return result;
```

The pending flag is cleared only after the backend accepts a sequence containing an ordinary input successfully.

History-based recovery and fork reapply the target workload's preamble to the first non-command member across the stored submissions. Native session resume restores its delivered state through driver persistent state.

## 9. Command handling

A command must remain the leading content of its canonical message. Commands before the first ordinary input remain untouched by preamble insertion:

```ts
const firstOrdinaryIndex = inputs.findIndex(
  (input) => input.type !== 'command',
);
```

A sequence containing only commands does not consume `preamblePending`. ACP lowering emits command text as the first content block and appends `context`; a harness without native command semantics may lower it to an ordinary message whose first line remains the command.

The handle switches on `AgentInput.type`; it never reparses slash syntax from backend-native messages.

## 10. Harness lowering

Each driver owns only the exhaustive conversion from the ordered canonical sequence into native input:

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

Lowering preserves order and does not inspect `submission.type`, `submission.content`, `ChatEnvelope`, canvas id, ACP binding, namespace, or Huabu render profiles.

Pi may retain multiple user-message boundaries directly. ACP may flatten them into one ordered content-block submission when its native prompt API has no equivalent multi-message call.

## 11. Logging, recovery, and fork

Keep the existing outer log field and persist the complete submission:

```text
beginTurn(submission)
  -> resolve rendered or generic fallback inputs
  -> handle preamble/command policy
  -> driver lowering
  -> execute harness
  -> append and fold AgentStreamEvents
  -> append AgentTurn { request: submission, transcript, meta }
```

Old Tier-1 and Tier-2 records already contain `{ type, content }` in `request`; they parse as submissions with `rendered === undefined`. New records add only the optional `rendered` field.

Recovery and fork call `resolveAgentInputs(turn.request)`:

- New records normally use their stored ordered canonical inputs.
- Old records use verbatim string content or JSON-stringified structured content.
- An explicit `rendered: []` remains an empty input sequence.

The target workload's `initialPreamble` is applied separately, so a fork does not carry source-agent preamble text into the target agent.

Backend-native input is never persisted. Base64 inside canonical `AgentInputPart` is persisted as-is in this scope.

## 12. Ownership table

| Value                          | Lifetime                       | Owner                           | Consumer                            |
| ------------------------------ | ------------------------------ | ------------------------------- | ----------------------------------- |
| `AgentSubmission.type/content` | one turn, durable              | host source model               | host history and projections        |
| `AgentSubmission.rendered`     | one turn, durable when present | host renderer                   | recovery, fork, and driver lowering |
| generic content fallback       | per resolution                 | Agenetes protocol/runtime       | submissions without `rendered`      |
| `WorkloadSpec.initialPreamble` | handle/session                 | host policy, executed by handle | handle preamble lifecycle           |
| backend-native input           | one execution                  | driver                          | pi harness or ACP session           |
| `AgentStreamEvent`             | one running turn               | driver translation              | live clients and durable fold       |

## 13. Implementation stages

### Stage 1: Protocol vocabulary

1. Replace `AgentRequest` with generic `AgentSubmission<TSource, TType>`.
2. Replace the current `{ message: string }` `AgentInput` with text, parts, and command members.
3. Add `resolveAgentInputs()` with presence-based fallback semantics.
4. Remove `defineRequest()` / `composeRequest()` and their conformance-only tests.
5. Extend `AgentTurn.request` to the submission schema with optional `rendered`.

### Stage 2: Behavior-preserving Huabu adapters

1. Promote server-local `ContentPart` to `AgentInputPart`.
2. Add `canvasId` to newly built `ChatEnvelope`s.
3. Adapt `INTERNAL_PROFILE` output to canonical `AgentInput[]`.
4. Adapt `ACP_PROFILE` / `ACP_SLASH_PROFILE` output to canonical `AgentInput[]`.
5. Emit `AgentCommandInput` for leading slash commands.
6. Construct complete submissions before calling either driver.

### Stage 3: Handle and driver boundary

1. Change `AgentHandle.run()` to `run(submission, ctx)`.
2. Change `turn_start` and Tier-2 logging to preserve the complete submission.
3. Remove `RenderFn`, `TRendered`, and `AgentTurnState` from the public run seam.
4. Add exhaustive pi and ACP sequence lowering.
5. Remove per-run render closures and Huabu wrap/unwrap helpers.

### Stage 4: Preamble lifecycle

1. Add ordered text-fragment `initialPreamble` to the shared workload contract.
2. Move ACP's first-message preamble and delivered flag into the handle.
3. Make command-only sequences defer preamble delivery.
4. Restore delivered state during native session resume.
5. Remove `binding.alias`, logger, `includeSystem`, and captured `canvasId` from ACP request rendering.

### Stage 5: Best-effort renderer convergence

1. Compare internal and external canonical inputs for equivalent envelopes.
2. Neutralize or relocate tool-surface-specific wording.
3. Replace the two stable adapters with one `renderChatEnvelope()` only when prompt and attachment parity is demonstrated.

## 14. Validation

The implementation must cover:

1. Old `{ type, content }` records parse with `rendered === undefined`.
2. New records preserve `type`, `content`, and ordered `rendered` inputs unchanged.
3. Missing `rendered` uses verbatim string content or one JSON text input.
4. `rendered: []` does not trigger fallback.
5. Internal and external adapters both produce valid ordered `AgentInput[]`.
6. One envelope may render into multiple ordered canonical messages.
7. Text and image parts lower equivalently to current pi and ACP payloads.
8. Rendering failure before `run()` creates no turn; execution failure after `run()` starts leaves an incomplete turn containing the submission.
9. An ordinary first input receives the initial preamble exactly once.
10. Multiple preamble fragments join in order with one blank line between fragments.
11. A failed ordinary submission does not consume the pending preamble.
12. Command-only input remains first and does not consume the pending preamble.
13. Recovery and fork use stored `rendered` inputs without host rendering.
14. Target preamble policy is applied independently from stored inputs.
15. Inline base64 image parts round-trip without storage optimization.
16. ACP namespace/session isolation and reachback remain independent of rendering.
17. If renderer convergence is performed, parity tests prove equivalent prompt and attachment behavior before deleting either adapter.

## 15. Expected code entry points

| File                                                                                                                                           | Responsibility                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`external/agenetes/packages/protocol/src/request.ts`](../../external/agenetes/packages/protocol/src/request.ts)                               | `AgentSubmission`, `AgentInput`, fallback normalization |
| [`external/agenetes/packages/protocol/src/turn.ts`](../../external/agenetes/packages/protocol/src/turn.ts)                                     | Durable submission on each folded turn                  |
| [`external/agenetes/packages/protocol/src/workload.ts`](../../external/agenetes/packages/protocol/src/workload.ts)                             | Ordered portable text-fragment `initialPreamble`        |
| [`external/agenetes/packages/runtime/src/handle.ts`](../../external/agenetes/packages/runtime/src/handle.ts)                                   | `run(submission, ctx)` execution seam                   |
| [`external/agenetes/packages/pi-driver/src/handle.ts`](../../external/agenetes/packages/pi-driver/src/handle.ts)                               | Preamble policy and pi sequence lowering                |
| [`external/agenetes/packages/acp-driver/src/handle.ts`](../../external/agenetes/packages/acp-driver/src/handle.ts)                             | Preamble/command policy and ACP sequence lowering       |
| [`external/agenetes/packages/agenetes/src/instance.ts`](../../external/agenetes/packages/agenetes/src/instance.ts)                             | Logging decoration over complete submissions            |
| [`external/agenetes/packages/agenetes/src/event-log.ts`](../../external/agenetes/packages/agenetes/src/event-log.ts)                           | Tier-1 `turn_start` submission persistence              |
| [`external/agenetes/packages/agenetes/src/materialize-history.ts`](../../external/agenetes/packages/agenetes/src/materialize-history.ts)       | Complete and incomplete turn materialization            |
| [`apps/server/src/modules/agent/conversation/envelope.ts`](../../apps/server/src/modules/agent/conversation/envelope.ts)                       | Huabu source content including `canvasId`               |
| [`apps/server/src/modules/agent/conversation/prompt/build-prompt.ts`](../../apps/server/src/modules/agent/conversation/prompt/build-prompt.ts) | Canonical adapters and eventual shared renderer         |
| [`apps/server/src/modules/agent/agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts)                                       | Internal submission construction                        |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                                           | External submission construction                        |
