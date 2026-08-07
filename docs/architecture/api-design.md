# API Design Spec

> Authoritative · Last updated 2026-05-08

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
