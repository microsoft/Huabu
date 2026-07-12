# Agent Submission and Input Boundary

> Status: **Draft**
>
> Last updated: 2026-07-12

## 1. Summary

Separate the durable semantic request from the clean input consumed by an agent harness.

`AgentHandle.run()` receives an `AgentSubmission` containing both representations:

```ts
type AgentSubmission<TRequest extends AgentRequest = AgentRequest> =
  | {
      readonly sourceRequest: TRequest;
      readonly agentInputs: readonly AgentInput[];
    }
  | {
      readonly sourceRequest: null;
      readonly agentInputs: readonly [];
    };
```

`sourceRequest` is the structured, JSON-serializable source used by host history and projections. `agentInputs` is the ordered, already-rendered, driver-agnostic message sequence used to reconstruct backend context during recovery and fork and sent onward to the pi or ACP harness. One UI request may render into zero, one, or many agent messages.

Request rendering happens before `run()` through a host-composed registry keyed by `sourceRequest.type`. The registry is created once; callers do not pass a render function on every turn. `run()` does not resolve or invoke renderers.

The handle may prepend a portable text `initialPreamble` from `WorkloadSpec` to the first ordinary message. A command is a distinct `AgentInput` member, allowing the handle to preserve a leading slash command and defer the preamble until the next ordinary message.

Both fields are persisted in the turn log. The backend-native result of lowering `agentInputs` remains ephemeral.

## 2. Problem

The current `AgentHandle.run(request, render, ctx)` seam combines two different boundaries:

```text
L1 -> L2
AgentRequest / ChatEnvelope
durable semantic source for logs and lifecycle operations

L2 -> harness
Message[] / ACP blocks
ephemeral input for actual execution
```

A driver currently receives the durable request only because Agenetes must log it, then invokes a caller-supplied renderer to obtain backend-native input. This makes the generic handle simultaneously act as a logging boundary, request-rendering boundary, and harness execution boundary.

Consequences include:

1. Every upper-layer turn passes a renderer even when request semantics are stable.
2. Backend-native rendered types leak into the generic handle signature.
3. Drivers see host request variants such as `huabu.chat`.
4. `AgentTurnState` crosses back into host rendering to support backend lifecycle details such as ACP's one-shot preamble.
5. The ownership of raw request data, prompt composition, session state, and native lowering is difficult to explain independently.

## 3. Goals

1. Give `run()` one explicit envelope containing the durable source request and ordered canonical agent inputs.
2. Persist the source request, canonical agent input sequence, and folded output transcript.
3. Let internal and external agents use the same pre-registered `huabu.chat` renderer.
4. Remove rendering logic and renderer resolution from `AgentHandle.run()`.
5. Keep harness-facing input free of canvas, binding, logging, and host request concepts.
6. Preserve text and image input without forcing either driver to understand `ChatEnvelope`.
7. Move first-message preamble delivery into handle lifecycle state.
8. Represent slash commands explicitly so preamble handling never relies on reparsing backend-native messages.
9. Extend Tier-1 and Tier-2 compatibly so recovery and fork consume stored canonical input instead of re-rendering historical source requests.

## 4. Non-goals

This proposal does not make ACP binding or namespace part of request rendering.

This proposal does not expose handle state to request renderers.

This proposal does not require pi and ACP to use the same backend-native message format.

This proposal does not make the request renderer responsible for system/session lifecycle.

This proposal does not persist backend-native pi messages or ACP blocks. Canonical `AgentInput` is the durable execution representation.

This proposal does not optimize the storage size of base64 image parts. Replacing inline image data with durable artifact references is a separate follow-up.

## 5. Boundary contracts

### 5.1 `AgentRequest`: durable semantic source

`AgentRequest` remains the driver-agnostic discriminated request union:

```ts
interface HuabuChatRequest {
  readonly type: 'huabu.chat';
  readonly content: ChatEnvelope;
}
```

It is plain serializable data and remains the source-request value stored in `turn_start` and `AgentTurn.request`.

The host may add request variants without changing drivers. Drivers never dispatch on `AgentRequest.type`.

### 5.2 `AgentInput`: clean harness input

`AgentInput` is one canonical message in the vocabulary between the handle and a harness adapter:

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

`AgentInput` contains no request discriminant, canvas id, ACP profile binding, namespace, logger, abort signal, or turn metadata. It is nevertheless serializable and durable because recovery and fork need the already-rendered input rather than a new rendering of the historical source request.

The current server-local `ContentPart[]` already matches the text/image portion of this vocabulary and should be promoted rather than reimplemented.

### 5.3 `AgentSubmission`: the complete `run()` envelope

`AgentSubmission` pairs the two boundary values without treating either as the other:

```ts
export type AgentSubmission<TRequest extends AgentRequest = AgentRequest> =
  | {
      readonly sourceRequest: TRequest;
      readonly agentInputs: readonly AgentInput[];
    }
  | {
      readonly sourceRequest: null;
      readonly agentInputs: readonly [];
    };
```

The null member fixes resume-without-input to an empty sequence. A non-null source request may render to zero, one, or many inputs; drivers define whether an empty rendered sequence is a no-op or invalid.

`sourceRequest` is intentionally not named `rawRequest`: it has already been parsed into a structured semantic request and is not raw bytes. `agentInputs` is intentionally not named `renderedMessages`: each member may be a command or structured parts and has not yet been lowered to pi `Message[]` or ACP blocks.

## 6. Rendering before `run()`

The host composes a request renderer registry once:

```ts
const requestRenderers = composeRequest([
  defineRequest({
    type: 'huabu.chat',
    schema: huabuChatRequestSchema,
    render: renderHuabuChat,
  }),
]);
```

The renderer is independent of handle and session state:

```ts
type AgentInputRenderer<TRequest> = (
  request: TRequest,
) => readonly AgentInput[] | Promise<readonly AgentInput[]>;
```

An ordinary upper-layer call becomes:

```ts
const sourceRequest = wrapChatRequest(envelope);
const agentInputs = await requestRenderers.render(sourceRequest);

await consume(
  handle.run(
    {
      sourceRequest,
      agentInputs,
    },
    turnContext,
  ),
);
```

No function is passed to `run()`. An exceptional caller overrides rendering by constructing a different `agentInputs` sequence, not by changing handle execution semantics.

An unknown or unregistered request variant uses a default renderer:

```ts
function renderRequestAsJson(request: AgentRequest): readonly AgentInput[] {
  return [
    {
      type: 'text',
      text: JSON.stringify(request),
    },
  ];
}
```

The default serializes the complete request, including its `type`. Serialization or rendering failure occurs before `run()` and propagates to the caller; because no submission reached the handle, no Tier-1 turn is started for that failure.

## 7. One renderer for internal and external Huabu chat

Both routes already build the same `ChatEnvelope`, and both already delegate most prompt composition to the same `renderTurn()` function. The remaining difference is that the shared composer currently receives `INTERNAL_PROFILE`, `ACP_PROFILE`, or `ACP_SLASH_PROFILE`.

The target model registers one `huabu.chat` renderer:

```text
ChatEnvelope
  -> renderHuabuChat()
  -> AgentInput[]
  -> AgentSubmission
       |-> pi lowerInputs()  -> Message[]
       `-> ACP lowerInputs() -> ACP content blocks
```

`renderHuabuChat()` performs slash-command recognition once:

```ts
async function renderHuabuChat(
  request: HuabuChatRequest,
): Promise<readonly AgentInput[]> {
  const parts = await renderTurn(request.content);

  if (isSlashCommand(request.content.user.text)) {
    return [
      {
        type: 'command',
        text: request.content.user.text,
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

The current internal/reachback profile wording must either become neutral request wording or move into the portable initial preamble that describes the available tool surface. Driver lowering must remain mechanical and must not select Huabu prompt wording.

`ChatEnvelope` should carry the `canvasId` already known by `buildChatEnvelope()` so attachment resolution does not rely on a per-turn closure:

```ts
interface ChatEnvelope {
  readonly canvasId: string | null;
  readonly user: ...;
  readonly skills: ...;
  readonly focus: ...;
}
```

Historical envelopes without `canvasId` normalize it to `null` at the host boundary. No durable-data rewrite is required.

ACP binding remains `{ alias, profileId }`; canvas-scoped session isolation remains in `WorkloadSpec.namespace`; reachback remains in `WorkloadSpec.env`. None of these values enters `renderHuabuChat()`.

## 8. Portable initial preamble

Add a portable text-only member to `WorkloadSpec`:

```ts
interface WorkloadSpec {
  readonly initialPreamble?: string;
}
```

`initialPreamble` is not a backend-native system-role message. Its contract is to be concatenated with the first ordinary `AgentInput` accepted by the handle.

The handle tracks delivery independently from the number of native session messages:

```ts
class AgentHandle {
  private preamblePending = this.spec.initialPreamble !== undefined;
}
```

For ordinary input:

```ts
const effectiveInputs = this.preamblePending
  ? prependToFirstOrdinaryInput(
      this.spec.initialPreamble,
      submission.agentInputs,
    )
  : submission.agentInputs;

const result = await this.runInputs(effectiveInputs, ctx);
if (containsOrdinaryInput(effectiveInputs)) {
  this.preamblePending = false;
}
return result;
```

The pending flag is cleared only after the backend accepts a sequence containing an ordinary input successfully. History-based recovery and fork reapply the target workload's preamble to the first stored non-command member across the ordered `agentInputs` sequences; native session resume restores its existing delivered state through the driver persistent state.

This replaces the current pattern in which ACP gives `isFirstMessage` to a host renderer so that the renderer can prepend `external-agent/system_prompt.md`.

## 9. Command handling

A command must remain the leading content of its submitted message. The handle therefore scans the sequence for the first ordinary input rather than prepending blindly:

```ts
const firstOrdinaryIndex = submission.agentInputs.findIndex(
  (input) => input.type !== 'command',
);
```

Commands before that index remain untouched. A sequence containing only commands does not consume `preamblePending`:

```text
first input is a command
  -> send command first
  -> keep preamblePending = true

next input is an ordinary message
  -> prepend initialPreamble
  -> clear preamblePending after successful submission
```

ACP lowering emits the command text as the first content block and appends `context` afterwards. A harness without native command semantics may lower it to an ordinary message whose first line remains the command.

The handle switches on each `agentInputs[index].type`; it never reparses slash syntax from backend-native messages.

## 10. Harness lowering

Each driver owns only the exhaustive conversion from the ordered `AgentInput` sequence into its native input:

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

Lowering preserves canonical input order and does not inspect `sourceRequest`, `ChatEnvelope`, request type, canvas id, ACP binding, namespace, or Huabu render profiles. Pi may retain multiple user-message boundaries directly; ACP may flatten them into one ordered content-block submission when its native prompt API has no equivalent multi-message call.

## 11. Logging and lifecycle compatibility

The logging decorator starts the turn from the complete submission:

```text
beginTurn(sourceRequest, agentInputs)
  -> handle preamble/command policy
  -> driver lowering
  -> execute harness
  -> append and fold AgentStreamEvents
  -> append AgentTurn { request: sourceRequest, agentInputs, transcript, meta }
```

Tier 1 stores both `sourceRequest` and ordered `agentInputs` in `turn_start`; Tier 2 stores both in the folded `AgentTurn`. The preamble-composed effective sequence and backend-native messages are not persisted because the workload spec supplies the target preamble and each driver can lower canonical input again.

New turn records require `agentInputs`. Legacy Tier-1 and Tier-2 records without them remain readable through an optional compatibility field; when recovery or fork needs such a turn, the host request renderer materializes `agentInputs` from the stored source request as a legacy-only fallback. This cannot guarantee historical renderer identity, which is why every new turn stores the canonical sequence.

`request === null` becomes `{ sourceRequest: null, agentInputs: [] }` and preserves its current driver-defined resume semantics.

History, recovery, and fork continue to consume materialized `AgentTurn[]`. Recovery and fork use each stored `agentInputs` sequence directly, apply the target workload's preamble policy across the ordered history, and let the target driver lower it to native backend input without inspecting or re-rendering `sourceRequest`.

`sourceRequest` and `agentInputs` are complementary durable representations rather than competing sources of truth: the former preserves host semantics, while the latter preserves execution semantics and message boundaries. Backend-native input may still be emitted through explicit debug instrumentation but is not durable.

## 12. Ownership table

| Value                           | Lifetime          | Owner                           | Consumer                            |
| ------------------------------- | ----------------- | ------------------------------- | ----------------------------------- |
| `WorkloadSpec.initialPreamble`  | handle/session    | host policy, executed by handle | handle preamble lifecycle           |
| `AgentSubmission.sourceRequest` | one turn, durable | host request model              | host history and projections        |
| `AgentSubmission.agentInputs`   | one turn, durable | pre-registered host renderer    | recovery, fork, and driver lowering |
| backend-native input            | one submission    | driver                          | pi harness or ACP session           |
| `AgentStreamEvent`              | one running turn  | driver translation              | live clients and durable fold       |

## 13. Implementation stages

### Stage 1: Protocol vocabulary

1. Replace the current `{ message: string }` `AgentInput` with the text, parts, and command union.
2. Add `AgentSubmission`.
3. Make `defineRequest()` / `composeRequest()` asynchronous and return `readonly AgentInput[]`.
4. Add the complete-request JSON fallback.

### Stage 2: Shared Huabu renderer

1. Promote the current server-local `ContentPart` vocabulary to `AgentInputPart`.
2. Add `canvasId` to newly built `ChatEnvelope`s with backward-compatible normalization.
3. Consolidate `INTERNAL_PROFILE` / `ACP_PROFILE` request wording into one `renderHuabuChat()` policy.
4. Emit `AgentCommandInput` for leading slash commands.
5. Register the composed renderer once at the host composition root.

### Stage 3: Handle and driver boundary

1. Change `AgentHandle.run()` to `run(submission, ctx)`.
2. Change `turn_start` and logging decoration to persist both submission fields.
3. Remove `RenderFn`, `TRendered`, and `AgentTurnState` from the public run seam.
4. Add exhaustive pi and ACP `AgentInput` lowering.
5. Remove per-run render closures from `agent.service.ts` and `acp/service.ts`.

### Stage 4: Preamble lifecycle

1. Add text-only `initialPreamble` to the shared workload contract.
2. Move ACP's first-message preamble composition and delivered flag into the handle.
3. Make command input defer preamble delivery.
4. Persist or recover the delivered state through the driver's existing persistent state mechanism.
5. Remove `binding.alias`, logger, `includeSystem`, and captured `canvasId` from ACP request rendering.

## 14. Validation

The implementation must cover:

1. `sourceRequest` and the ordered canonical `agentInputs` sequence are logged unchanged while backend-native input is never persisted.
2. Internal and external chat invoke the same registered `huabu.chat` renderer.
3. Text and image parts lower equivalently to current pi and ACP payloads.
4. JSON fallback preserves the complete unknown request.
5. Rendering failure occurs before `run()` and does not create an incomplete turn.
6. Harness execution failure after `run()` starts does create an incomplete turn.
7. An ordinary first input receives the initial preamble exactly once.
8. A failed first submission does not consume the pending preamble.
9. A command remains first and does not consume the pending preamble.
10. A harness without command semantics receives an ordinary message with the command still leading.
11. Historical envelopes without `canvasId` remain readable.
12. Recovery and fork use stored `agentInputs` without re-rendering new turns, while legacy turns without them use the explicit compatibility fallback.
13. Target preamble policy is reapplied to the first ordinary member across stored `agentInputs`, independently from commands.
14. Inline base64 image parts round-trip through Tier 1 and Tier 2 without a storage optimization in this scope.
15. ACP namespace/session isolation and reachback remain independent of request rendering.

## 15. Expected code entry points

| File                                                                                                                                           | Responsibility                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`external/agenetes/packages/protocol/src/request.ts`](../../external/agenetes/packages/protocol/src/request.ts)                               | `AgentRequest`, `AgentInput`, `AgentSubmission`, request composition |
| [`external/agenetes/packages/protocol/src/turn.ts`](../../external/agenetes/packages/protocol/src/turn.ts)                                     | Durable ordered `agentInputs` on each folded turn                    |
| [`external/agenetes/packages/protocol/src/workload.ts`](../../external/agenetes/packages/protocol/src/workload.ts)                             | Portable text `initialPreamble`                                      |
| [`external/agenetes/packages/runtime/src/handle.ts`](../../external/agenetes/packages/runtime/src/handle.ts)                                   | `run(submission, ctx)` execution seam                                |
| [`external/agenetes/packages/pi-driver/src/handle.ts`](../../external/agenetes/packages/pi-driver/src/handle.ts)                               | Preamble policy and pi lowering                                      |
| [`external/agenetes/packages/acp-driver/src/handle.ts`](../../external/agenetes/packages/acp-driver/src/handle.ts)                             | Preamble/command policy and ACP lowering                             |
| [`external/agenetes/packages/agenetes/src/instance.ts`](../../external/agenetes/packages/agenetes/src/instance.ts)                             | Logging decoration over both submission fields                       |
| [`external/agenetes/packages/agenetes/src/event-log.ts`](../../external/agenetes/packages/agenetes/src/event-log.ts)                           | Tier-1 `turn_start` persistence for both submission fields           |
| [`external/agenetes/packages/agenetes/src/materialize-history.ts`](../../external/agenetes/packages/agenetes/src/materialize-history.ts)       | Complete and incomplete turn materialization with `agentInputs`      |
| [`apps/server/src/modules/agent/conversation/envelope.ts`](../../apps/server/src/modules/agent/conversation/envelope.ts)                       | Self-contained Huabu source request including `canvasId`             |
| [`apps/server/src/modules/agent/conversation/prompt/build-prompt.ts`](../../apps/server/src/modules/agent/conversation/prompt/build-prompt.ts) | Shared `huabu.chat` renderer                                         |
| [`apps/server/src/modules/agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts)                                 | Renderer registration and driver composition                         |
| [`apps/server/src/modules/agent/agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts)                                       | Internal submission construction                                     |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                                           | External submission construction                                     |
