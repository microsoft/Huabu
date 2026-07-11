/**
 * Host binding of the `@agenetes/runtime` execution seam.
 *
 * The generic `AgentHandle` / `RenderFn` contracts and the driver
 * register/injection seam now live in the host-agnostic
 * [`@agenetes/runtime`](../../../../../../external/agenetes/packages/runtime)
 * package (L2). This module binds them to the host's concrete types — the
 * per-turn request is the canvas {@link ChatEnvelope}; the transcript delta
 * a turn returns is pi-ai `Message[]` — so the rest of `apps/server` keeps
 * a single, stable import surface while the contracts themselves stay in
 * the subtree.
 *
 * Standard drivers (`@agenetes/acp-driver`, `@agenetes/pi-driver`) now
 * live in subtree packages and are injected into the runtime through the
 * host's mount/adapter layer (`./drivers.ts`, `./pi-driver.ts`). This
 * module only binds the generic execution seam to the host's concrete
 * request/transcript/event types.
 */

import type { ChatEnvelope } from '../conversation/envelope.js';
import type {
  AgentHandle as RuntimeAgentHandle,
  RenderFn as RuntimeRenderFn,
} from '@agenetes/runtime';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentStreamEvent } from '@sediment/shared';

export type { AgentDriver, AgentRuntime } from '@agenetes/runtime';
export { createAgentRuntime } from '@agenetes/runtime';

/**
 * The host's `AgentRequest` variant discriminant. The host adopts the
 * `@agenetes/protocol` request contract (`{ type, content }`, README I6):
 * its single per-turn request variant wraps the canvas {@link ChatEnvelope}
 * as `content`. Persisting it to the L2 turn log (I9.8) is `JSON.stringify`,
 * and `AgentTurn.request` replays it verbatim — the driver-agnostic source
 * of truth for both history rendering and built-in context assembly.
 */
export const HUABU_CHAT_REQUEST_TYPE = 'huabu.chat';

/**
 * The per-turn request a host handle accepts — the `{ type, content }`
 * request-variant contract with the canvas {@link ChatEnvelope} riding as
 * `content`. Bound here (not in the subtree) so `@agenetes/runtime` stays
 * host-agnostic; `content` is opaque to L2 (`AgentRequest.content` is
 * `unknown`), so the whole envelope persists losslessly.
 */
export interface AgentRequest {
  readonly type: typeof HUABU_CHAT_REQUEST_TYPE;
  readonly content: ChatEnvelope;
}

/** Wrap a {@link ChatEnvelope} into the persisted host {@link AgentRequest}. */
export function wrapChatRequest(envelope: ChatEnvelope): AgentRequest {
  return { type: HUABU_CHAT_REQUEST_TYPE, content: envelope };
}

/**
 * Recover the {@link ChatEnvelope} from a persisted `AgentTurn.request`
 * (the L2 folded turn, README I9.8). Returns `null` for a resume turn
 * (`request === null`) or any request that is not the host's `huabu.chat`
 * variant — the caller then emits no user bubble / user message.
 */
export function unwrapChatRequest(request: unknown): ChatEnvelope | null {
  if (
    request &&
    typeof request === 'object' &&
    (request as { type?: unknown }).type === HUABU_CHAT_REQUEST_TYPE
  ) {
    return (request as { content: ChatEnvelope }).content;
  }
  return null;
}

/**
 * Host-bound render fn: the request is always the host {@link AgentRequest}.
 * `TRendered` is the backend-native render output (pi-ai `Message[]` for the
 * built-in pi-driver path, ACP prompt blocks for the external path).
 */
export type RenderFn<TRendered> = RuntimeRenderFn<AgentRequest, TRendered>;

/**
 * The events a host handle actually emits: every host `AgentStreamEvent`
 * frame except the transport-synthesized `meta` / `end` (those are added by
 * the route around a turn, not by a handle). This is the host-extended
 * event union the subtree `AgentHandle` is bound to via its `TEvent`
 * parameter — it stays protocol-assignable, so the wire contract holds.
 */
export type InStreamEvent = Exclude<AgentStreamEvent, { type: 'meta' | 'end' }>;

/**
 * Host-bound handle: request = {@link AgentRequest}, transcript result =
 * pi-ai `Message[]`, events = host {@link InStreamEvent}. `TRendered` (the
 * backend-native render output) and `TTurnCtx` (the per-turn context each
 * driver's `run` accepts) stay open per backend. Facets (`run` /
 * `control` / `close` / `capabilities`) are defined by the subtree
 * {@link RuntimeAgentHandle}.
 */
export type AgentHandle<
  TRendered = unknown,
  TTurnCtx = unknown,
> = RuntimeAgentHandle<
  AgentRequest,
  TRendered,
  Message[],
  InStreamEvent,
  TTurnCtx
>;
