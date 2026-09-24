# API Design Spec

> Authoritative · Last updated 2026-09-15

How every HTTP / SSE endpoint is defined and consumed across `apps/server`
and `apps/web`. Deviations require updating this file in the same PR.

## Rules

1. **Wire contracts live in `packages/shared/src/types/api/*`.** Never
   define a request/response shape inside `apps/server` or `apps/web`.
2. **One source of truth.** Define a zod schema, derive the type via
   `z.infer`. Don't pair a hand-written interface with a schema.
3. **Validate every network input.** Body / query / format-sensitive
   params go through `safeParse` before any business logic. `Body: T` is
   compile-time only — it does not validate at runtime.
4. **Errors use `ApiErrorBody`** (`{ message, code?, details? }`) with
   HTTP 4xx/5xx. Success bodies are plain payloads. Only use an in-body
   `{ ok: false }` for true business outcomes (e.g. user cancelled a
   dialog) returned with HTTP 200.
5. **Web bundle stays zod-free.** Web code must `import type` only from
   `@huabu/shared`. `sideEffects: false` + `consistent-type-imports`
   ESLint rule enforce this.

> **Carve-out — the L1↔L2 Agenetes control-plane contract.** The driver-agnostic, reusable control-plane primitives (`WorkloadSpec` building blocks, the `AgentStreamEvent` mirror, `ControlMsg`, `AgentCapabilities`) live in the extractable [`@agenetes/protocol`](../../external/agenetes/packages/protocol) package rather than `packages/shared/src/types/api/*` — they are a standalone control-plane contract meant to be adopted by other hosts, not Huabu-specific HTTP wire types. Rules 2–5 still hold there (zod single-source, `safeParse` at the trust boundary, web imports as `import type` only). Host-specific pieces (a driver's `spec`/`request`, e.g. `BuiltinAgentSpec` / `ChatEnvelope`) stay under `packages/shared` and bind into the protocol via `defineBinding`. See [layered-architecture.md §5](../proposals/layered-architecture.md#5-inter-layer-contracts-the-seams).

## Layout

| File                                                   | Role                                       |
| ------------------------------------------------------ | ------------------------------------------ |
| `packages/shared/src/types/api/<feature>.ts`           | schema + inferred types + response types   |
| `apps/server/src/modules/<feature>/<feature>.route.ts` | route handler                              |
| `apps/web/src/api/<feature>.ts`                        | client helper (uses `apiFetch` + routes)   |
| `apps/web/src/api/_routes.ts`                          | URL builders (`encodeURIComponent` inside) |
| `apps/web/src/api/_client.ts`                          | `apiFetch` / `ApiError`                    |

## End-to-end template

**Shared** — `packages/shared/src/types/api/echo.ts`

```ts
import { z } from 'zod';

export const echoBodySchema = z.object({
  message: z.string().min(1).max(280),
});
export type EchoBody = z.infer<typeof echoBodySchema>;

export interface EchoResponse {
  echoed: string;
  at: number;
}
```

**Server** — `apps/server/src/modules/echo/echo.route.ts`

```ts
import {
  echoBodySchema,
  type ApiResult,
  type EchoBody,
  type EchoResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const echoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: EchoBody; Reply: ApiResult<EchoResponse> }>(
    '/',
    async (request, reply) => {
      const parsed = echoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'Invalid body',
        });
      }
      return reply.send({ echoed: parsed.data.message, at: Date.now() });
    },
  );
};

export default echoRoutes;
```

**Web** — `apps/web/src/api/echo.ts`

```ts
import { apiFetch } from './_client';
import { routes } from './_routes';

import type { EchoBody, EchoResponse } from '@huabu/shared';

export async function postEcho(body: EchoBody): Promise<EchoResponse> {
  return apiFetch<EchoResponse>(routes.echo, {
    method: 'POST',
    json: body,
    fallbackMessage: 'Failed to echo',
  });
}
```

## Conventions

- **Naming**: `<purpose>Schema` for schemas, `<Purpose>Body` /
  `<Purpose>Response` for types.
- **Wire body vs internal request**: when a handler augments the body
  with URL params, name them distinctly (e.g. `PreprocessNodeBody` is
  what the client sends; `PreprocessNodeRequest` adds `canvasId` /
  `nodeId` from `request.params`). Don't smuggle URL ids into the body.
- **SSE**: event names live in shared (`AGENT_SSE_EVENTS` etc.). The
  request body that opens the stream still follows rule 3. Always emit
  a final `End` or `Error` event before `reply.raw.end()`.
- **Error message**: take from the first zod issue, fall back to a
  fixed string. Never ship `error.format()` — it leaks zod internals.

## Agent Node owner-specific writes

[`agent-node.ts`](../../packages/shared/src/types/api/agent-node.ts) defines the bounded editable node schema, launch overrides, association bodies, result acknowledgements, and internal projection shape. `PUT /api/canvas/:canvasId` accepts editable fields, not a complete replacement read model: omitted fields remain unchanged, Question FSM fields cannot be submitted, and the server composes from current state under the Canvas mutex. The same ownership guard applies to ordinary `MERGE_NODE_DATA`, regardless of the submitted originator. It does not reserve unrelated node types' `status` or thread-reference metadata.

Question `conversationTitleSource` is also server-owned and excluded from ordinary editable snapshots, commands, and undo. It records naming provenance only; the canonical node `label` remains the title value. Trusted shared-service title writes use the canonical node projection and Canvas Sync path, while ordinary user/agent label renames retain their existing protection against automatic naming. Chat-to-Question creation transfers naming authority using the current backend title rather than establishing a second mutable thread title. See [Question naming](./question-node.md#2-data-model--persistence).

`POST /api/canvas/:canvasId/nodes/:nodeId/association` initializes a legacy Question or validates undo reinsertion; it cannot replace an existing thread association. `POST /api/canvas/:canvasId/nodes/:nodeId/viewed` accepts `{ invocationToken }` and returns `{ acknowledged }`, where false means the observed token is no longer the current terminal result. A null acknowledgement token is the bounded legacy case: it succeeds only for a terminal node whose token is still absent, and cannot acknowledge any newly admitted result. Both use shared schemas and `safeParse`. Trusted FSM projection is an in-process business writer, not an HTTP endpoint or client-controlled originator privilege. Canvas Sync may emit `agentNodeProjection` to keep these server effects out of editable undo.

## Conversation titles

[`conversation-title.ts`](../../packages/shared/src/types/api/conversation-title.ts) defines the shared schemas and inferred types for `ConversationTitle { title, source }`, batch queries, and manual renames. `POST /api/agent/threads/titles/query` validates `{ canvasId, threadIds }` (at most 100 thread IDs; an empty batch is valid) and returns `{ titles }` keyed by thread ID. `PUT /api/agent/threads/:threadId/title?canvasId=...` validates params, query, and a trimmed non-empty `{ title }` of at most 120 characters, returning the effective title or `404 thread_not_found` when no writable Question or durable thread exists.

Both routes await the shared `ConversationTitleService`: current Question ownership resolves to the canonical node label and protected provenance, otherwise the durable thread owns its host title. A missing owner produces `{ title: null, source: null }` on query, not an error. Queries never generate titles, realize an Agent, or repair metadata. The backend alone normalizes and arbitrates title sources; the frontend caches exact responses and keeps pre-send unbound manual intent locally until durable creation. Existing thread events invalidate cache entries, and Question naming uses Canvas Sync; no separate title SSE contract is added. See [conversation naming policy](./agent-architecture.md#panel-conversation-titles).

## Agent history paging

`GET /api/agent/history/:threadId/page` is the bounded display-history endpoint. Its canonical contract is [`agent-history.ts`](../../packages/shared/src/types/api/agent-history.ts): `threadId` and required `canvasId` are non-empty, `limit` is an integer from 1 through 20, and optional `before` is an opaque exclusive cursor. The server validates params and query with `safeParse` before resolving a namespace.

Success returns `{ threadId, turns, before?, hasMore }`. Each `turns[]` entry is `{ id, messages, active?, activeMessageStart? }`: `id` is the stable display-group identity used to prepend/deduplicate and replace a completed active projection, `messages` are chronological `ChatHistoryItem`s for the whole group, and `active: true` marks a group containing the read-time incomplete Tier-1 projection. `activeMessageStart` identifies the first message from that projection when a continuation shares a group with persisted messages, allowing reconnect replay to replace only the active suffix. `before` addresses the page immediately older than the oldest returned group; older-page requests never include an active tail.

Malformed request fields and malformed cursors return HTTP 400 with `code: "malformed_history_request"` or `code: "malformed_history_cursor"`. A cursor whose thread generation was replaced or rehomed returns HTTP 409 with `code: "stale_history_cursor"`. The existing `GET /api/agent/history/:threadId` remains the unbounded compatibility endpoint for current consumers; pagination is not applied implicitly to model recovery or complete-history callers.

## RFS Agent discovery

`POST /api/rfs/:canvasId/agent/:threadId/ink-intent` uses `rfsInkIntentParamsSchema`, `rfsInkIntentRequestSchema`, and `rfsInkIntentResponseSchema` in `types/api/rfs.ts`, reusing `inkIntentReportSchema`. RFS decodes its raw JSON buffer, validates the target and body with `safeParse`, and delegates to the shared Ink writer. A per-turn invocation token must match the active external turn; inactive, expired, or wrong-scope reports return `409 ink_turn_inactive`. The token is a freshness guard, not a credential; the normal RFS Bearer requirement remains mandatory.

`POST /api/rfs/:canvasId/query` with `type: "INSPECT_NODES"` uses the canonical response contract in [`space-operations.ts`](../../packages/shared/src/types/api/space-operations.ts). Each Question Node result includes its non-empty persisted `threadId` when associated; non-Question Nodes and unbound Questions omit the field. The mapping is scoped by the authenticated RFS URL's Canvas and is read-only: inspection does not create a thread, workload, binding, realization, or invocation. Callers continue the mapped conversation through the existing `POST /api/rfs/:canvasId/agent/:threadId/prompt` SSE endpoint.

## Anti-patterns

| Don't                                               | Do                                              |
| --------------------------------------------------- | ----------------------------------------------- |
| Inline `z.object({...})` in a route file            | Author schema in shared, import it              |
| `fastify.post<{ Body: T }>` with no `safeParse`     | Always parse before destructuring               |
| `if (!body.field)` truthy "validation"              | Use a zod schema                                |
| Hand-written interface + matching zod schema        | One schema, derive type with `z.infer`          |
| Hard-coded `fetch('/api/foo/' + id)` in a component | Add a helper in `apps/web/src/api/<feature>.ts` |
| Wire types defined in `apps/server` or `apps/web`   | Move to `packages/shared/src/types/api/`        |

## Verifying bundle stays clean

```bash
cd apps/web && pnpm build
grep -l 'ZodObject\|safeParse' dist/assets/*.js && echo LEAK || echo OK
```

`OK` is the only acceptable output.

## Code entry points

| File                                                                                           | Responsibility                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [types/api/](../../packages/shared/src/types/api)                                              | Canonical wire schemas and inferred types                                            |
| [agent-node.ts](../../packages/shared/src/types/api/agent-node.ts)                             | Bounded Question edit, association, result-acknowledgement, and projection contracts |
| [canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts)                        | Runtime input validation and owner-specific Canvas operations                        |
| [canvas.ts](../../apps/web/src/api/canvas.ts)                                                  | Type-only web contract imports and Canvas HTTP helpers                               |
| [conversation-title.ts](../../packages/shared/src/types/api/conversation-title.ts)             | Canonical title query and rename schemas                                             |
| [conversation-title.route.ts](../../apps/server/src/modules/agent/conversation-title.route.ts) | Validated Canvas-scoped title routes                                                 |
