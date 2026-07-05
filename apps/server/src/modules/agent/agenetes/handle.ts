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
 * The two concrete handles (`BuiltinAgentHandle`, `AcpAgentHandle`) still
 * live in the host and are injected into the runtime as driver objects
 * (see `./drivers.ts`): standard drivers (ACP) are destined to move into
 * the subtree once M4/M5 make their host couplings injectable; the
 * canvas-coupled built-in driver stays host-owned and injected. See
 * docs/proposals/layered-architecture.md §3.6 / §7.
 */

import type { ChatEnvelope } from '../conversation/envelope.js';
import type {
  AgentHandle as RuntimeAgentHandle,
  RenderFn as RuntimeRenderFn,
} from '@agenetes/runtime';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentStreamEvent } from '@sediment/shared';

export type {
  AgentDriver,
  AgentDriverInfo,
  AgentRuntime,
} from '@agenetes/runtime';
export { createAgentRuntime } from '@agenetes/runtime';

/**
 * The per-turn request a host handle accepts — the canvas
 * {@link ChatEnvelope}. Bound here (not in the subtree) so `@agenetes/runtime`
 * stays host-agnostic; a future driver-agnostic `@agenetes/protocol`
 * request union would replace this alias without touching the seam.
 */
export type AgentRequest = ChatEnvelope;

/**
 * Host-bound render fn: the request is always the host {@link AgentRequest}.
 * `TRendered` is the backend-native render output (pi-ai `Message[]` for the
 * built-in path, ACP prompt blocks for the external path).
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
 * pi-ai `Message[]`, events = host {@link InStreamEvent}. `TRendered` stays
 * open per backend. Facets (`submit` / `events` / `control` /
 * `capabilities`) are defined by the subtree {@link RuntimeAgentHandle}.
 */
export type AgentHandle<TRendered = unknown> = RuntimeAgentHandle<
  AgentRequest,
  TRendered,
  Message[],
  InStreamEvent
>;
