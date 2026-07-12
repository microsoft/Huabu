# Agent Request Render Resolution

> Status: **Draft**
>
> Last updated: 2026-07-12

## 1. Summary

Resolve request rendering through one ordered ladder instead of requiring every `AgentHandle.run()` call to supply a backend-native renderer:

```text
per-run native renderer
  > per-driver native renderer
  > per-request-type AgentInput renderer
  > default JSON AgentTextInput renderer
  > driver lowerInput()
```

The first implementation is deliberately transitional. Existing pi and ACP rich renderers may remain backend-native at the two highest-priority levels, while request-type and default renderers produce the canonical `AgentInput`. This removes repetitive per-turn wiring without forcing image parts, ACP prompt metadata, and every existing backend detail into the first `AgentInput` revision.

Rendering remains host application-owned. Drivers select and invoke an injected renderer at the last moment, supply the narrow driver-agnostic `AgentTurnState`, and lower canonical input into their backend-native prompt shape when no native override was selected.

## 2. Context

The current runtime contract requires `run(request, render, ctx)` on every turn. Huabu consequently rebuilds equivalent closures at both built-in and ACP call sites even though the request variant is normally the same `huabu.chat` envelope and the rendering policy is stable across turns.

The protocol package already contains `defineRequest()` / `composeRequest()` and an initial `{ message: string }` `AgentInput`, while pi-driver already declares an unused `renderFallback` port. The implementation therefore has the pieces of a request-oriented rendering model but currently bypasses them in favour of mandatory per-run backend-native rendering.

The desired resolution order is:

1. An exceptional turn may provide a per-run override.
2. A driver registration may provide a backend-specific renderer shared by its handles.
3. Otherwise the request's `type` selects a host-composed canonical renderer.
4. An unknown or unregistered request type falls back to rendering the complete request as JSON text.

## 3. Goals

1. Make the renderer argument optional at ordinary upper-layer `run()` call sites.
2. Preserve an explicit per-run override for exceptional backend-specific turns.
3. Allow a host-injected per-driver renderer to preserve existing rich pi and ACP behaviour during migration.
4. Make request-type rendering reusable across drivers and keyed by the request discriminant rather than the driver route.
5. Provide a universal text fallback that every text-capable driver can lower.
6. Keep `AgentTurnState` narrow and driver-agnostic.
7. Preserve the existing durable logging, history, recovery, and fork formats without migration.
8. Make `ChatEnvelope` carry every canvas fact required to render itself, including `canvasId`, instead of relying on a call-site closure.

## 4. Non-goals

This proposal does not make `binding`, `WorkloadSpec`, or opaque per-turn `ctx` visible to a request renderer.

This proposal does not make ACP session binding part of prompt rendering. ACP binding continues to select a profile and session recipe; canvas isolation continues to ride the workload namespace.

This proposal does not require the first implementation to represent every rich backend input as canonical `AgentInput`.

This proposal does not persist rendered input, backend-native prompts, or resolved renderer identity.

This proposal does not change the `AgentTurn`, `AgentStreamEvent`, Tier-1 event log, or Tier-2 turn log schemas.

## 5. Request and input model

### 5.1 Raw request remains the durable source of truth

The caller submits a plain JSON-serializable request:

```ts
interface HuabuChatRequest {
  readonly type: 'huabu.chat';
  readonly content: ChatEnvelope;
}
```

The raw request remains independent of the driver and is persisted verbatim in `turn_start` / `AgentTurn.request`. Rendering is an ephemeral projection performed only when a live driver consumes a non-null request.

### 5.2 `ChatEnvelope` carries render inputs

`ChatEnvelope` should add the canvas identity already known by `buildChatEnvelope()`:

```ts
interface ChatEnvelope {
  readonly canvasId: string | null;
  readonly user: ...;
  readonly skills: ...;
  readonly focus: ...;
}
```

The Huabu renderer can then derive markdown, attachment references, and image resolution context from the request alone. The current ACP closure must no longer capture `canvasId`.

Historical envelopes without `canvasId` are read as `null`; no durable-data rewrite is required. This compatibility normalization belongs at the host envelope boundary, not in Agenetes.

`binding.alias` is not rendering input. It is currently used only for diagnostics in ACP preprocessing and should be removed from the prompt-builder contract. Logging belongs around renderer execution rather than inside the deterministic request template.

### 5.3 Canonical text input

Replace the current implicit `{ message: string }` shape with an extensible discriminated member:

```ts
export interface AgentTextInput {
  readonly type: 'text';
  readonly text: string;
}

export type AgentInput = AgentTextInput;
```

`AgentInput` starts as a one-member union so drivers can exhaustively lower it today and a future `AgentPartsInput` can be added without redefining what text means.

The default renderer serializes the complete request, including its `type`, rather than serializing only `request.content`:

```ts
function renderRequestAsJson(request: AgentRequest): AgentTextInput {
  return {
    type: 'text',
    text: JSON.stringify(request),
  };
}
```

If serialization fails, resolution throws an explicit render error. It must not return a success-shaped placeholder.

## 6. Renderer scopes

### 6.1 State remains narrow

All renderers continue to receive the existing driver-supplied state:

```ts
interface AgentTurnState {
  readonly isFirstMessage: boolean;
}
```

The state describes generic session position; it does not expose `WorkloadSpec`, ACP binding, driver internals, logger, abort signal, overlay, or the opaque per-turn context.

Additional state fields may be added only when they are meaningful across drivers, such as a turn index or recovered-session flag. A renderer may ignore state and remain stateless.

### 6.2 Native renderer

The compatibility renderer keeps the current output type:

```ts
type NativeRenderFn<TRequest, TRendered> = (
  request: TRequest,
  state: AgentTurnState,
) => TRendered | Promise<TRendered>;
```

A per-run native renderer is an exceptional override. A per-driver native renderer is injected by the host at driver registration and shared across handles; it must derive request semantics from the request and generic state, not from a handle-specific closure.

For the initial migration, Huabu may register:

- `huabu.chat -> Message[]` as the pi per-driver renderer.
- `huabu.chat -> PreparedAcpPrompt` as the ACP per-driver renderer.

Both can read `canvasId` from `request.content`. ACP profile binding and namespace remain outside rendering.

### 6.3 Canonical request renderer

A request-type renderer produces `AgentInput`:

```ts
type AgentInputRenderer<TRequest> = (
  request: TRequest,
  state: AgentTurnState,
) => AgentInput | Promise<AgentInput>;
```

The host composes these renderers by request `type` and injects the composed registry once when mounting Agenetes. A driver does not define the semantics of `huabu.chat`; it only receives the registry and lowers its result.

The existing `defineRequest()` / `composeRequest()` API should evolve to support `AgentTurnState` and asynchronous rendering rather than introducing a second unrelated request registry.

## 7. Resolution algorithm

For a non-null request, a driver resolves exactly one path:

```ts
async function resolveRenderedInput(options): Promise<TRendered> {
  const nativeRenderer = options.perRun ?? options.perDriver;

  if (nativeRenderer) {
    return nativeRenderer(options.request, options.state);
  }

  const inputRenderer =
    options.requestRenderers.get(options.request.type) ?? renderRequestAsJson;

  const input = await inputRenderer(options.request, options.state);
  return options.lowerInput(input);
}
```

Resolution is based only on renderer presence. If the selected renderer throws or rejects, the error propagates; the resolver must not retry a lower-priority renderer because that would conceal defects and could submit a materially different prompt.

`request === null` bypasses resolution entirely and retains its current driver-defined meaning.

## 8. Driver lowering

Each driver owns only the conversion from canonical `AgentInput` to its backend-native submission shape:

```ts
type LowerInputFn<TRendered> = (
  input: AgentInput,
) => TRendered | Promise<TRendered>;
```

The initial lowerings are straightforward:

```text
AgentTextInput -> pi user Message[]
AgentTextInput -> ACP text content block
```

Lowering must not inspect the host request type, canvas identity, ACP binding, or Huabu markdown semantics.

When canonical rich input is later required, add an `AgentPartsInput` member with text/image parts and extend each driver's exhaustive lowering. That migration can then remove the corresponding native renderer without changing upper-layer `run()` calls.

## 9. Upper-layer API

Reorder the runtime call so ordinary calls do not pass an empty renderer position:

```ts
run(
  request: TRequest | null,
  ctx: TTurnCtx,
  options?: {
    render?: NativeRenderFn<TRequest, TRendered>;
  },
): AsyncGenerator<TEvent, TResult>;
```

The normal Huabu call becomes:

```ts
const handle = await agenetes.getOrCreate(spec);

for await (const event of handle.run(wrapChatRequest(envelope), turnContext)) {
  yield event;
}
```

An exceptional turn may still override rendering:

```ts
handle.run(request, turnContext, {
  render: renderSpecialNativeInput,
});
```

The host registers stable driver and request policies once at composition:

```ts
const agenetes = mountAgenetes({
  requestRenderers: composeRequest([
    defineRequest({
      type: 'huabu.chat',
      schema: huabuChatRequestSchema,
      render: renderHuabuChatInput,
    }),
  ]),
  drivers: {
    pi: createPiDriverFactory({
      ports: piPorts,
      render: renderHuabuChatForPi,
    }),
    acp: createAcpDriverFactory({
      ports: acpPorts,
      render: renderHuabuChatForAcp,
    }),
  },
});
```

The concrete builder surface may differ, but ownership must remain as shown: request semantics are host registrations, driver-native compatibility renderers are host injections, and drivers own only resolution mechanics plus lowering.

## 10. Logging, recovery, and fork compatibility

The logging decorator must call `beginTurn(originalRequest)` before advancing the driver's async generator, exactly as it does today. Renderer resolution remains inside the wrapped `run()` generator.

The data path remains:

```text
beginTurn(original request)
  -> resolve renderer
  -> render / lower
  -> execute backend
  -> append and fold AgentStreamEvents
  -> append completed AgentTurn
```

Neither `AgentInput` nor backend-native rendered input is persisted. Existing logs therefore require no schema conversion or migration.

If rendering fails, the original request remains visible as an incomplete Tier-1 turn, preserving the current failure semantics and allowing `history({ withTail: true })` to materialize it.

Recovery and fork continue to consume materialized `AgentTurn[]`. They do not depend on which renderer won resolution for the original live turn.

## 11. ACP canvas and binding boundaries

ACP's profile binding remains:

```ts
binding: {
  alias: string;
  profileId: string;
}
```

Canvas-scoped session isolation remains encoded separately through `spec.namespace = canvasAcpNamespace(canvasId)`, and reachback configuration continues to ride `spec.env`.

The same `canvasId` may also appear in `ChatEnvelope` because it serves a different purpose: it is request data required to render that envelope deterministically. This does not make ACP binding canvas-aware and does not let the request renderer inspect the workload namespace.

## 12. Implementation stages

### Stage 1: Canonical text contract and resolver

1. Introduce `AgentTextInput` and make `AgentInput` a discriminated union.
2. Extend `defineRequest()` / `composeRequest()` for asynchronous state-aware rendering.
3. Add a shared typed resolver and explicit JSON render errors.
4. Add pi and ACP `AgentTextInput` lowerings.
5. Preserve current mandatory render call sites until the compatibility tests pass.

### Stage 2: Stable driver registration

1. Add an optional per-driver native renderer to both standard factory configurations.
2. Make the per-run renderer optional and adopt the new `run(request, ctx, options?)` call shape.
3. Move the current pi and ACP render functions from per-turn service closures to stable host registrations.
4. Add `canvasId` to newly built `ChatEnvelope`s and remove ACP render's captured `canvasId`.
5. Remove renderer-only `binding.alias` and logger parameters from ACP prompt preparation.

### Stage 3: Canonical Huabu rendering

1. Register `huabu.chat` as a request-type renderer.
2. Move drivers that need only text from native rendering to `AgentTextInput`.
3. Define `AgentPartsInput` before migrating any path whose current image or attachment behaviour cannot be represented losslessly as text.
4. Remove native compatibility renderers only after parity tests prove equivalent prompts and attachments.

## 13. Validation

The implementation must cover:

1. Each resolution precedence edge, including per-run over per-driver and per-driver over request-type.
2. Unknown request type JSON fallback preserving the full request object.
3. Selected renderer failure propagating without fallback.
4. `request === null` bypassing every renderer.
5. `AgentTurnState` reaching each renderer unchanged.
6. pi and ACP text lowering.
7. Existing rich pi and ACP prompt parity while native compatibility renderers remain.
8. Logging the original request rather than canonical or native rendered input.
9. Renderer failure leaving an incomplete turn snapshot.
10. Historical `ChatEnvelope`s without `canvasId` remaining readable.
11. ACP namespace/session isolation remaining independent of envelope rendering.

## 14. Expected code entry points

| File                                                                                                                     | Responsibility                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [`external/agenetes/packages/protocol/src/request.ts`](../../external/agenetes/packages/protocol/src/request.ts)         | `AgentInput`, request definitions, composed request renderer |
| [`external/agenetes/packages/runtime/src/handle.ts`](../../external/agenetes/packages/runtime/src/handle.ts)             | Optional per-run render contract and narrow `AgentTurnState` |
| `external/agenetes/packages/runtime/src/render.ts`                                                                       | Shared precedence resolver and render errors                 |
| [`external/agenetes/packages/pi-driver/src/types.ts`](../../external/agenetes/packages/pi-driver/src/types.ts)           | Per-driver native renderer configuration                     |
| [`external/agenetes/packages/pi-driver/src/handle.ts`](../../external/agenetes/packages/pi-driver/src/handle.ts)         | Resolution invocation and pi lowering                        |
| [`external/agenetes/packages/acp-driver/src/handle.ts`](../../external/agenetes/packages/acp-driver/src/handle.ts)       | Resolution invocation and ACP lowering                       |
| [`apps/server/src/modules/agent/conversation/envelope.ts`](../../apps/server/src/modules/agent/conversation/envelope.ts) | Self-contained Huabu request envelope including `canvasId`   |
| [`apps/server/src/modules/agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts)           | Host composition and stable renderer registration            |
| [`apps/server/src/modules/agent/agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts)                 | Built-in upper-layer call migration                          |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                     | ACP upper-layer call migration and closure removal           |
