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

## RFS Skill delivery

RFS Agent SSE in `all` mode reuses `AGENT_HOST_SSE_EVENTS.Accepted` and `agentTurnAcceptedSchema` from the existing Agent contract. The event is emitted only from the canonical durable acceptance promise, never from HTTP success or Thread creation; `final` mode retains its existing output. The CLI's acceptance-only option is local transport behavior, not a new HTTP response schema or cancellation operation.

`rfsSkillParamsSchema` in `packages/shared/src/types/api/rfs.ts` validates canvas and Skill path parameters for the authenticated focused-guide route. Root and focused Skills keep the existing `GET /api/rfs/:canvasId/skill[/<skillId>]` URLs. `X-Huabu-Skill-Client` selects `http` or `rfs-cli`; absence defaults to `http`, unknown values return `400`, and variant responses include `Vary: X-Huabu-Skill-Client`. Both presentations append the same live Skill Frames at the root. The former Space-root `skill.md` override is ignored. HTTP exposes `agents`, `interactive-views`, `layout`, `services`, and `tasks`; CLI intentionally exposes only `agents`, `layout`, and `services` while Task/View abstractions await redesign. Unknown or unavailable IDs retain explicit 404 errors. CLI Service commands reuse the existing Service HTTP contracts; local extraction output is not a new wire response.

## RFS legacy mutation gates

The existing RFS `POST /:canvasId/execute` validates its Space parameter with `recentCanvasConversationParamsSchema` and retains `rfsExecuteRequestSchema` and the existing partial-result response; its optional request id and read version are described under [request id and read version on execute](#request-id-and-read-version-on-execute). `POST` / `DELETE /:canvasId/upload/*` use `rfsUploadParamsSchema`; upload bodies remain raw bytes written directly to `space(canvasId).artifacts` with a fresh `artifact-<uuid><ext>` key, and the `{ id, size }` response is defined by `rfsUploadResponseSchema` plus its inferred type. Ordinary malformed input remains 400, absent staged files on legacy `DELETE` remain 404, and unexpected storage failures remain logged 500 errors. Upload mutation is leased and serialized under the Canvas mutex across every storage backend. See [RFS file projection](./agent-reachback.md#file-projection) for portable node/artifact resolution.

## Quoted Comment source evidence

`quotedCommentSchema` in `types/api/agent.ts`, reused by the Chat envelope, accepts optional `source: { kind: 'note', canvasId, nodeId, snapshotRevision }`. All source fields are nonempty strings; older Chat quotations omit `source` and retain assistant-passage rendering. Note source evidence describes the excerpt-time rendered document, not a saved-node CAS baseline or an authorization to access/edit that node. The server validates it with the existing Agent request/envelope schemas, preserves it in submitted history and renders escaped source metadata through the canonical source-specific Comment template shared by built-in and ACP Agents. No endpoint, recency write, new storage record or web runtime schema import is introduced.

The source is a discriminated union: File Reference Preview additionally accepts `{ kind: 'file-reference', canvasId, nodeId, agentletId, path, contentVersion, offsetUnit: 'utf-16', from, to, loadedLength, complete }`. Device/path validation reuses the device-files contract; contentVersion is a 64-digit lowercase hexadecimal filesystem-state fingerprint. Nonnegative integer offsets must satisfy `from < to <= loadedLength`; `complete` distinguishes the full file from a loaded prefix. Offsets refer to CodeMirror's normalized text, never raw UTF-8 bytes. File sources remain captured evidence rather than read/edit capabilities or assertions that the destination Agent can access the source device. The existing schema/envelope/history transport preserves the union, and draft consumption compares all source fields.

Selection toolbars additionally capture PDF evidence as `{ kind: 'pdf', canvasId, nodeId, pages }`, where pages is a nonempty array of positive one-based integers, and Chat evidence as `{ kind: 'chat', canvasId, threadId, messageId }`. Chat identity remains the source conversation even when staging into a different destination. Source strings are nonempty and the canonical renderer XML-escapes them. Both the quotation and its authored comment must be nonempty. Selection actions freeze evidence locally; only explicit confirmation of a non-whitespace comment stages it into the destination draft. Clearing a staged comment blocks submission until it is filled or removed, even when the main composer contains text. Ordinary text requests require non-whitespace main content or an authored quotation/comment; selecting material alone does not authorize a turn. The existing Agent request/envelope schemas validate and persist this extension; no endpoint or runtime web schema import is added.

## Historical detail projection

`GET /api/agent/history/:threadId/page` accepts optional `detailLevel=full|summary`, defaulting to the existing full display projection. Summary mode sends historical tool headers and typed `detail { state: "deferred", turnRef, summary }` markers; incomplete live turns are never reduced. `GET /api/agent/history/:threadId/turn?canvasId=...&turnRef=...` returns `{ threadId, turnRef, messages }`, the full display projection of one persisted turn, not its raw submission or an entire display group. Its shared contracts live in `agent-history.ts`; the opaque `turnRef` travels in the query, like the page `before` cursor, because a real reference is longer than the router's 100-character path-parameter limit; path/query inputs use `safeParse`, Space read authorization applies as for other Agent history routes, and a Workspace-operation lease spans the read and projection. References are interpreted only within that authorized namespace and must match thread and replacement generation. Malformed references return 400, stale generations 409, missing turns 404, and storage failures remain errors rather than empty successful details. Full tool parts carry `detail { state: "inline", turnRef }` for identity-checked client hydration.

## Agent Node owner-specific writes

### Who an execute request speaks for, and what it may carry

`POST /api/canvas/:canvasId/execute` is admitted once, before the engine runs, by `admitExecuteRequest` ([execute-admission.ts](../../apps/server/src/modules/canvas/execute-admission.ts)):

- **The source follows the credential.** A request that arrived with an agent or machine credential — the connection token, a device or reachback credential (`arrivedWithAgentCredential`) — is an agent's, and a person's session is `ui`. A request cannot say which: on the page route `originator` is a strict object of `tabId` alone, and a body that states `originator.source` or `originator.threadId` — any value, from any credential — is refused with 400. A batch is filed under a conversation only by the Server's own agent tools and by the RFS execute route, from the `X-Huabu-Host-Thread-Id` header of a request that arrived with an agent credential; a browser session cannot attribute its batch to a conversation. `system` is only ever the Server's own callers. The RFS execute route always runs as `agent`. There is no header or query parameter that selects the source on any execute entry. Tests that need an Agent's write make it as an Agent does, through the RFS route with the machine credential (`apps/web/e2e/agent-execute.ts`; the e2e backend's credential is set with `HUABU_CONNECTION_TOKEN`, as a deployment sets it).
- **Commands are well formed.** An edit's `commands` stay `unknown[]` in the body schema; each entry is then checked against the shape of its type (`canvasCommandShapeProblem`, [canvas-command-shape.ts](../../packages/shared/src/types/api/canvas-command-shape.ts): lists are lists, items objects, ids non-empty strings, points numbers; extra keys pass). A malformed command refuses the whole request with 400 `INVALID_COMMAND` naming its place (`edits[e].commands[i]`); nothing runs. Whether a well-formed command is acceptable — the node exists, the word is a known node type — stays the engine's per-command answer.
- **A page does not write bodies through execute.** A body (`content`, `src`, `dataSchema`) is protected by its content revision, checked by the content PUT for a page and by `expectRev` for an agent. For `ui`, a `MERGE_NODE_DATA` that sets or unsets a body key, and a `RESTORE_NODES` whose `replace` does not keep all body keys (`keepDataKeys`), are refused with 400 `UI_BODY_WRITE`. Creating a node, or restoring one that is gone, with its body is allowed: nothing is overwritten. The browser never sends either refused form (`commandsForServer` strips content keys; undo sends `keepDataKeys` with every content key).
- **Which command types a source may issue** is one rule in the engine, `isAllowedFor` ([commandScope.ts](../../packages/shared/src/canvas-engine/commandScope.ts)): an `agent` batch may not contain a UI-only type (`UI_ONLY_CANVAS_COMMAND_TYPES`), an `INITIALIZE_PDF_NOTE` with `noteId`, or a `MERGE_NODE_DATA` with `unset`; such a command is reported `applied: false, reason: 'invalid-scope'`. Handlers do not look at the source for this. Such a command fails the edit it is in.

### Request id and read version on execute

**One request body: a list of edits.** `POST /api/canvas/:canvasId/execute` (`postCanvasExecuteBodySchema`) takes `{ operationId?, runId?, originator?: { tabId? }, edits: Edit[] }` with `Edit = { basis?, after?: EditRef[], commands: CanvasCommand[] }` and `EditRef = { operationId?, edit }`. An edit is one intent — one gesture of a page, one step of an Agent — with the read version it was made on (`basis`, an opaque string of at most 128 characters built by `encodeBasis` in `packages/shared/src/utils/basis.ts`). There is no top-level `commands`, `basis` or `runs`: a body without `edits` is 400. `operationId` is a UUID request id; it requires an authenticated caller (401 otherwise), because stored outcomes are keyed by the transport-resolved principal, never by a value in the request. The server does not limit the number of commands on this route; a page sends at most 200 per request.

**Edits run in order, and an edit is all-or-nothing.** Each edit sees the state the edits before it left. An edit with a `basis` is judged for staleness once, before its first command. When any command of an edit does not take effect — every result that is not applied, except `no-op` (`isRefusedResult`) — none of the edit's commands take effect: the engine returns to the state the edit started from and drops what it had accumulated for it. An edit whose `after` names an edit that did not take effect does not run (`stale-parent`). Edits that are unrelated to it still apply. See [the engine rule](./canvas-command-architecture.md#edits).

**The Agent route keeps its documented form.** `POST /api/rfs/:canvasId/execute` (`rfsExecuteRequestSchema`) takes `{ commands, basis?, operationId?, runId? }` with at most 50 commands; the request id and basis may also travel as `X-Huabu-Operation-Id` / `X-Huabu-Basis` so a client can forward body bytes untouched (a malformed header, or one that differs from the body, is 400). That form is converted in one place (`editsPerCommand`, used by `preparedEditsOf` in the executor) into **one edit per command, each quoting the request's `basis`**, which is exactly its behaviour: a command that fails is skipped, the others apply, and nothing accepted is rolled back. Its response (`rfsExecuteResponseSchema`: flat `results` with `index` and `type`, the echo of the executed `commands`, `revisions`, `affected`, `conflicts`) is unchanged. A body-revision conflict (`expectRev`) still refuses the whole request, in both forms. The same route also accepts the edits form (`rfsExecuteEditsRequestSchema`, `{ operationId?, runId?, edits }`, 50 commands in total; an `X-Huabu-Basis` header is the basis of every edit that states none); its response is the same projection plus `edits: [{ applied, reason?, failedAt?, start, count }]`, where `start` and `count` address the flat `results`. Agents are not told about the edits form: guides, skills and tool descriptions describe `{ commands }` only. `huabu-rfs execute` forwards its input bytes as they are, so both forms pass through it unchanged.

**The response is grouped per edit.** `PostCanvasExecuteResponse` is `{ canvasId, fromVersion, toVersion, deltas?, edits, pendingEffects, orderEvents?, nodeContentRevisions?, runId?, operationId?, basis?, replayed?, incomplete? }`. `edits[i]` answers request edit `i`: `{ applied, reason?, failedAt?, results }`, with one `{ applied, reason?, nodes?, edges? }` per command. `applied` is true when no command of the edit failed (all of them may have been `no-op`s). `failedAt` is the position of the failing command; it is absent when the edit was refused before its first command ran (a stale read version, an edit it was made on top of). In a refused edit the failing command carries its reason, a command that had been a `no-op` stays `no-op`, and the others are `applied: false` without a reason. Commands are not echoed: the ids the server assigned are in `results[].nodes` (`nodeId`, label, size, image `src`) and `results[].edges` (`edgeId`, endpoints). `pendingEffects` names the mutated nodes by id (`mutatedNodeIds`); a page reads them from its own state after applying `deltas`. `deltas` name, per node, only the fields that changed ([delta format](./canvas-realtime-sync.md#broadcast-contract)).

**Request ids and replay.** A request id stores the _outcome_ of the request, not its response: per-edit and per-command results with generated ids, the ids the request touched, versions, order events, content revisions and the basis — never a node, a body or a delta (`ExecuteOutcome`, [execute-outcome.ts](../../apps/server/src/modules/canvas/execute-outcome.ts)). Sending the same request id with the same request again is answered from that outcome and marked `replayed: true`; nothing is executed or published twice. On the Canvas route a replayed response is the first response **without `deltas`**: what the request changed reached every page with the `update` event, and a page that has not applied `toVersion` yet waits for that event or loads the Space. On the Agent route a replayed response is the first response field for field (it never carried deltas); the echo of the executed commands is kept in the outcome for that route only. An outcome that would not fit a result record (4 MiB) is stored without its optional parts — the command echo, order events, per-command node and edge lists — and such a replay says `incomplete: true`; a retry therefore never executes a second time. The response echoes `operationId` and carries `basis`, the read version after the request (RFS always returns it; the Canvas route returns it when `operationId` or an edit's `basis` was supplied). `GET /api/rfs/:canvasId/execute/:operationId` returns the answer of the caller's earlier Agent-route request without executing anything, or 404 `operation_not_found` when it was never saved, belongs to another caller, was stored by the Canvas route or has expired (records are kept 14 days). Reads return the current basis: every member of `spaceQueryResponseSchema` has a required `basis`, and node downloads send it as `X-Huabu-Basis`. `GET /capabilities` reports `operationIdIsIdempotencyKey: true`; `runId` remains a tracing label, not an identity.

The `POST /api/canvas/:canvasId/execute` response (`PostCanvasExecuteResponse`) and the `update` sync event (`canvasSyncEventSchema`) carry an optional `nodeContentRevisions: { [nodeId]: rev }`: the stored content revision of every sidecar-backed node whose saved content the batch created or changed, hashed like the field of the same name on `GET /api/canvas/:canvasId`. It is omitted when the batch changed no node content, and a replay returns it unchanged. The RFS execute response does not carry it. A consumer that ignores it behaves as before; a page uses it as the `expectRev` baseline of the node's next content save instead of hashing the node in `deltas`. See [content revisions of a batch](./canvas-realtime-sync.md#content-revisions-of-a-batch).

**Read version.** An edit's `basis` is checked over the target nodes of its commands, once, against the state its first command would run against. A stale target refuses the edit: `stale-target` (a target is gone, or was created after the basis) or `stale-parent` (a target a command depends on the parent of — a positioned node of a geometry command, the nodes of parent, reorder, align and distribute commands, the nodes a Frame layout places — moved to another parent after the basis); the two reasons are members of `CanvasCommandFailureReason`, and every command of the refused edit is reported with it. Other edits are unaffected. For the Agent route's `{ commands, basis }` this is the per-command check it always was, since each command is its own edit. A change the same page committed itself — the same authenticated principal and the same `originator.tabId` — does not make a target stale. See [reliable save](./canvas-storage.md#42-reliable-save-in-the-write) for the rules and storage.

**Made on top of.** `after` names earlier edits of the same caller that an edit was made on top of while they were still unconfirmed: `{ edit }` for an earlier edit of this request (a reference to itself or to a later edit is 400), `{ operationId, edit }` for an edit of an earlier request, looked up in that request's stored outcome in the caller's own key space. When the named edit did not take effect, or its outcome is not stored, the edit is refused with `stale-parent`. At most 64 are named. With a request id, the edits are part of what "the same request" means. A basis that is not a read version of the Space refuses the whole request with `basis-unknown`. `GET /api/canvas/:canvasId` returns `basis`, the read version taken before the state was read; a page combines its lineage with the version it has applied since. See [read versions of a page](./canvas-realtime-sync.md#read-versions-of-a-page).

Three cases reject the whole request rather than producing a command result:

| Status | Code                        | Meaning                                                                                                    |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 409    | `operation-id-reused`       | The request id was already used for a different request. Nothing was applied.                              |
| 409    | `basis-unknown`             | The basis is not a read version of this Space (other lineage, or above head). Nothing was applied.         |
| 503    | `operation-outcome-unknown` | Persistence failed and the outcome could not be determined. Retry with the same request id, not a new one. |

The Canvas route uses the same codes in its `{ code, message }` error body. The Canvas Sync `update` event carries the optional `operationId` of the batch that produced it, so a client can recognise the echo of its own write. Review records of an agent batch are saved in that same write; the RFS route attributes them to the claimed thread only after confirming server-side that the thread belongs to this Space.

`huabu-rfs execute` sends a fresh request id per invocation unless `--operation-id <uuid>` is given, buffers the body (`{ commands }` or `{ edits }`, forwarded byte for byte), and retries a bounded number of times with the same id and body on a fetch failure, timeout or 503 `operation-outcome-unknown`; on final failure it prints `operation-id=<id>` on stderr. A replayed answer is printed like any other. `huabu-rfs result <operation-id>` calls the lookup endpoint.

The browser sends its own structure edits through `POST /api/canvas/:canvasId/execute` with `originator: { tabId }`, an `operationId` and one edit per gesture, each with its own `basis`; a failed request is repeated with the same id and the same body. The `update` event also carries `source`, the batch's source (`ui`, `agent` or `system`). See [browser structure edits](./canvas-realtime-sync.md#browser-structure-edits).

Not covered: the node content PUT accepts neither field, so its lost replies are not replayable and its writes are not read-version checked. There is no whole-canvas `PUT /api/canvas/:canvasId`; structure is written only through commands (see [browser structure edits](./canvas-realtime-sync.md#browser-structure-edits)). All machine-token callers share one principal, so two external agents must not reuse each other's request ids. There is no caller-visible session, no commit replay stream and no per-Space switch.

Canvas Sync's shared `CanvasSyncEvent` union includes `invalidate` with `{ nodeIds?: string[], originPageId?: string }`. Successful node-content saves, node-sidecar deletion and Space-tree deletion publish this bounded read-model notification. Server-side conversation snapshot subscriptions reread matching owners (all observed owners in the Space when `nodeIds` is absent); Canvas renderers do not interpret it as editable deltas. A node-content save names its node, and `originPageId` repeats the optional `pageId` of the `PUT …/nodes/:nodeId/content` body (at most 64 characters, not stored); every other Canvas page then reads that node with `GET …/nodes/:nodeId/content`, whose response carries the sidecar fields, including `provenance`, the whole `properties` bag and `propertyDisplayKeys`, and their `rev`. The PUT body's `properties` is a keywise patch (`null` deletes a key) and `propertyDisplayKeys` replaces the display order; neither is checked against `expectRev`, which is the revision of the body only (`content` and `src`). The same holds for a title a person or an agent gave (`label` / `labelSource` other than `auto`): it is last-writer-wins. `expectRev` is checked for a request of an authored node type that carries the body or something derived from one — `content`, `src`, `summary`, `keywords`, `provenance`, or an automatic title (`labelSource: 'auto'`). A request that carries none of those is never refused as stale and an `expectRev` in it is ignored; a request that carries some of them and whose `expectRev` is stale is answered `409 NODE_CONTENT_CONFLICT`, and the authored title and the property patch beside them are written all the same, reported as `titleApplied: true` and `propertiesApplied: true`: only the body and what is derived from it were refused. A title another node already uses (`labelSource: 'user'`) is `409 NODE_LABEL_CONFLICT` in either case, and nothing of that request is written. An agent `MERGE_NODE_DATA` patch entry needs `expectRev` only when it carries `content`. See [node content between pages](./canvas-realtime-sync.md#node-content-between-pages). `INITIALIZE_PDF_NOTE` accepts an optional `noteId` from a `ui` batch only; the agent schema (`initializePdfNoteCommandSchema`, strict) does not have it. Canvas stream path parameters use `recentCanvasConversationParamsSchema.safeParse`.

Space presence adds `POST /api/canvas/:canvasId/presence` (`canvasPresenceReportBodySchema`, strict) and `POST /api/canvas/:canvasId/presence/leave` (`canvasPresenceLeaveBodySchema`), both read-access routes that answer 204 and touch no storage — an entry belongs to the caller's principal together with its `pageId`, the report has no name field, and `editingNodeIds` is taken only from a caller with write access — an optional `pageId` query on the Canvas Sync stream (`canvasSyncStreamQuerySchema`) and a `presence` event (`canvasPresenceEventSchema`) on that stream, which is not a member of `CanvasSyncEvent`. Limits are in the zod-free `canvas-presence-limits.ts` so the web bundle can import them. A refused report is 429 with `PRESENCE_RATE_LIMITED` or `PRESENCE_SPACE_FULL`; the web helper reads the status itself instead of `apiFetch`, so a refused report does not raise the application-wide rate-limit notice. See [Space presence](./canvas-realtime-sync.md#space-presence).

`GET /api/agent/owner/:threadId/stream?canvasId=...` is the authenticated conversation-state SSE endpoint. It shares parameter/query validation and the bounded canonical owner reader with `GET /api/agent/owner/:threadId?canvasId=...`. `agentConversationOwnerEventSchema` in `agent-node.ts` defines `snapshot { streamId, revision, value }`, where `value` is either `{ state: "ready", owner }` or `{ state: "unavailable", status, error }`. Revisions increase within a connection; a fresh `streamId` identifies each new baseline, including after process restart. These are complete metadata snapshots, not transcript or Canvas deltas. Subscription precedes the initial read, notifications coalesce, a write arriving during a read invalidates its result before publication, and identical states are not republished. The shared Canvas publisher covers projection, edits, moves, deletion and Space rename; this route does not introduce an independent writer or persistent event log.

Both transports stamp completed canonical reads with `observation { epoch, revision }`: `owner.observation` for ready states and `error.details.observation` for unavailable states. The process epoch is distinct from the SSE connection ID, and the monotonic counter is assigned under the Canvas mutex, so observations for the same owner can be ordered across HTTP and SSE without relying on network arrival order. The shared schema permits missing observations for older peers/fixtures; only that compatibility path retains conservative arrival-order fencing. These counters are not durable storage versions or a distributed ordering protocol. Explicit write validation still uses the ordinary owner endpoint; history hydration and reply attachment can use observed ownership without another metadata GET.

Each GET or SSE metadata read has a ten-second deadline covering mutex waiting and storage reads. The reader acquires its Workspace lease only after entering the mutex and captures one Workspace-bound Space handle, reusing the canonical Agent resolver against that captured Canvas. Cancellation stops the read workflow and releases its mutex and lease; an already queued cancelled task cannot acquire a lease or start storage work. Non-cancellable driver I/O may finish independently, but is read-only, scoped to the captured handle, cannot continue to another read or publish a result, and prevents duplicate owner reads of that same Workspace/Space record or node until it settles. A blocked driver therefore does not pin application coordination or accumulate duplicate queries on reconnect; this does not promise driver-level query cancellation. GET failures return 408/503; SSE read failures emit a typed `error` and close for retry. Confirmed unavailable snapshots stay subscribed for restoration. Heartbeats run every fifteen seconds, and closing a client releases the subscriber and timers.

[`agent-node.ts`](../../packages/shared/src/types/api/agent-node.ts) defines the bounded editable node schema, launch overrides, association bodies, result acknowledgements, and internal projection shape. Structure edits through `POST /api/canvas/:canvasId/execute` carry editable fields, not a replacement read model: a `MERGE_NODE_DATA` patch that names a Question's FSM fields is not applied, regardless of the submitted originator, and the server composes from current state under the Canvas mutex. It does not reserve unrelated node types' `status` or thread-reference metadata.

A command batch or delta replay that carries Agent preparation is compared against the current node under that mutex using `changesAgentNodePreparation` (there is no whole-Space PUT; structure reaches storage through `execute` only). Unchanged preparation echoed by another edit does not require execution-record confirmation or promote binding state. Actual preparation changes still acquire draft admission and validate canonical execution; explicit guarded commands and Agent interactions retain their confirmation and promotion behavior. Mode changes also acquire the nonblocking turn lease through persistence, including commands and delta replay; edits racing an admitted preparation or execution fail with `agent_draft_busy` (HTTP 409). Mode remains mutable on idle Bound nodes, unlike execution identity. Input schemas, server-owned field rejection, association preservation, and Canvas version checks apply to every such write regardless of whether preparation changes.

Question `conversationTitleSource` is also server-owned and excluded from ordinary editable snapshots, commands, and undo. It records naming provenance only; the canonical node `label` remains the title value. Trusted shared-service title writes use the canonical node projection and Canvas Sync path, while ordinary user/agent label renames retain their existing protection against automatic naming. Chat-to-Question creation transfers naming authority using the current backend title rather than establishing a second mutable thread title. See [Question naming](./question-node.md#2-data-model--persistence).

`POST /api/canvas/:canvasId/nodes/:nodeId/association` initializes a legacy Question or validates undo reinsertion; it cannot replace an existing thread association. `POST /api/canvas/:canvasId/nodes/:nodeId/viewed` accepts `{ invocationToken }` and returns `{ acknowledged }`, where false means the observed token is no longer the current terminal result. A null acknowledgement token is the bounded legacy case: it succeeds only for a terminal node whose token is still absent, and cannot acknowledge any newly admitted result. Both use shared schemas and `safeParse`. Trusted FSM projection is an in-process business writer, not an HTTP endpoint or client-controlled originator privilege. Canvas Sync may emit `agentNodeProjection` to keep these server effects out of editable undo.

## Recent anchored conversation

Ink clients exclude a remembered destination when its live node is known to be built-in Ask; this does not rewrite the shared recency pointer or change the conversation's mode. Other unavailable targets still block sending rather than silently retargeting. Server invocation admission independently rejects built-in Ask for `ink-intent`; `POST /api/agent` returns HTTP 409 with `code: ink_agent_read_only` before stream acceptance. Ordinary text and external session permissions remain unchanged.

`GET /api/canvas/:canvasId/recent-conversation` validates params with `recentCanvasConversationParamsSchema` and returns `RecentCanvasConversationResponse`, inferred from the shared response schema: `{ conversation: { nodeId, threadId } | null }`. The value is the Space's most recently accepted node-anchored chat destination, shared across clients. It changes for both text ChatPanel and Ink submissions only when the canonical durable `turn_start` is accepted, not on picker changes, preparation, or execution completion. Later execution failure still counts. The target is retained when its node is deleted or moved, so clients can explicitly block an unavailable destination instead of silently choosing New. A missing Space returns 404, invalid IDs return 400, and storage/integrity failure returns 500 with `RECENT_CONVERSATION_READ_FAILED`; `null` means there is no remembered accepted target. Existing Spaces begin without a remembered target until their first qualifying acceptance after this feature is installed.

The endpoint's Space existence check and recency lookup share one captured Space handle under the same Workspace-operation lease and Canvas mutex; a Workspace activation cannot occur between validation and the response's storage reads. Pending acceptance is reconciled against canonical history and persisted without the pending marker, so subsequent GETs do not repeatedly scan history. If that repair write fails, the server logs the failure and returns the verified conversation rather than rejecting a proven acceptance; the pending marker remains available for another repair attempt. Canonical history or index read failures still produce the explicit 500 response.

## Space card activity and inline rename

`types/api/space-card.ts` defines the schemas and inferred types for `POST /api/canvas/cards/query` and `PATCH /api/canvas/:canvasId/title`. The rename advances the Space's version without changing a node and publishes the Canvas Sync `update` from the previous version to the new one, with no deltas and the optional `title` field set, so open pages follow the version and show the title without loading the Space again; the browser's own Space rename uses this endpoint. The query accepts 1–50 validated Space IDs and returns a per-ID `ready`, `missing`, or `error` snapshot; ready entries include canonical title, `updatedAt`, and an `activity` array with one entry per represented Agent thread. `SpaceCardAgent` contains `nodeId`, `threadId`, nullable conversation `title`, optional `agentBinding`/`agentIcon`/`agentMode`, and `status` (`running`, `approval`, `error`, `unread`, `unknown`, or `idle`). Reads are Workspace-leased and combine topology/runtime state with targeted Agent-node reads for canonical labels; they never read conversation history or start Agents. The response excludes prompts, node bodies, and launch overrides. Per-Space read failures are logged and explicitly returned rather than disguised as empty activity.

Rename validates the Space ID and `{ title, expectedTitle }`, trims and rejects empty names, and refuses a stale title with `409 SPACE_TITLE_CHANGED`. Repository title collisions use `409 CANVAS_TITLE_CONFLICT`; missing/World targets use 404/403. The Canvas mutex and Workspace lease protect rename plus metadata version advancement, with no target topology replacement. Rename/storage failure returns an explicit error because the repository rename and record write are not crash-atomic. See [Space cards](./space-preview.md#3-web-rendering-and-freshness) for refresh, activity, and editing semantics.

## Cross-Space Move errors

`POST /api/canvas/:canvasId/move-selection` validates its params and body with the shared Move schemas. Errors expose only a bounded `MOVE_*` code and fixed English message. `MOVE_AGENT_CLOSE_FAILED`, `MOVE_AGENT_REHOME_FAILED`, and unexpected `MOVE_FAILED` return HTTP 500; eligibility/history and destination conflicts retain their existing 4xx behavior. Agenetes `rehome_unknown_outcome` and failed compensation become HTTP 500 `MOVE_OUTCOME_UNKNOWN` before cleanup decisions. No raw cause, namespace, thread identity, artifact name, or arbitrary exception message is serialized. Server diagnostics retain the operation phase, allowlisted upstream error code, failure category, and compensation/cleanup outcome; original causes remain internal and are not dumped into logs. Web Move presentation localizes the code and uses a safe generic fallback rather than displaying unknown error messages.

## Canary branch configuration

`GET /api/deployment/canary` returns the effective bounded `branch`, nullable `configuredBranch`, branch-bound remote check state, and a redeployment result carrying its own captured branch. `PUT /api/deployment/canary/config` accepts `{ branch: string | null }`, where null clears the override and resolves to `alpha`; the Server validates the full Git ref and exact fixed-`origin` availability before persisting. `POST /api/deployment/canary/check` retains a strict empty body. `POST /api/deployment/canary/redeploy` accepts `{ expectedBranch }` only as a freshness guard and rejects a mismatch rather than treating the request as a target selector. All bodies use the canonical schemas in `deployment.ts`, all routes remain owner-only, and operation conflicts are explicit HTTP 409 responses.

## Conversation titles

[`conversation-title.ts`](../../packages/shared/src/types/api/conversation-title.ts) defines the shared schemas and inferred types for `ConversationTitle { title, source }`, batch queries, and manual renames. `POST /api/agent/threads/titles/query` validates `{ canvasId, threadIds }` (at most 100 thread IDs; an empty batch is valid) and returns `{ titles }` keyed by thread ID. `PUT /api/agent/threads/:threadId/title?canvasId=...` validates params, query, and a trimmed non-empty `{ title }` of at most 120 characters, returning the effective title or `404 thread_not_found` when no writable Question or durable thread exists.

Both routes await the shared `ConversationTitleService`: current Question ownership resolves to the canonical node label and protected provenance, otherwise the durable thread owns its host title. A missing owner produces `{ title: null, source: null }` on query, not an error. Queries never generate titles, realize an Agent, or repair metadata. The backend alone normalizes and arbitrates title sources; the frontend caches exact responses and keeps pre-send unbound manual intent locally until durable creation. Existing thread events invalidate cache entries, and Question naming uses Canvas Sync; no separate title SSE contract is added. See [conversation naming policy](./agent-architecture.md#panel-conversation-titles).

## Agent history paging

`GET /api/agent/history/:threadId/page` is the bounded display-history endpoint. Its canonical contract is [`agent-history.ts`](../../packages/shared/src/types/api/agent-history.ts): `threadId` and required `canvasId` are non-empty, `limit` is an integer from 1 through 20, and optional `before` is an opaque exclusive cursor. The server validates params and query with `safeParse` before resolving a namespace.

Success returns `{ threadId, turns, before?, hasMore }`. Each `turns[]` entry is `{ id, messages, active?, activeMessageStart? }`: `id` is the stable display-group identity used to prepend/deduplicate and replace a completed active projection, `messages` are chronological `ChatHistoryItem`s for the whole group, and `active: true` marks a group containing the read-time incomplete Tier-1 projection. `activeMessageStart` identifies the first message from that projection when a continuation shares a group with persisted messages, allowing reconnect replay to replace only the active suffix. `before` addresses the page immediately older than the oldest returned group; older-page requests never include an active tail.

Malformed request fields and malformed cursors return HTTP 400 with `code: "malformed_history_request"` or `code: "malformed_history_cursor"`. A cursor whose thread generation was replaced or rehomed returns HTTP 409 with `code: "stale_history_cursor"`. The existing `GET /api/agent/history/:threadId` remains the unbounded compatibility endpoint for current consumers; pagination is not applied implicitly to model recovery or complete-history callers.

## External-agent runtime configuration

`GET/PUT /api/acp/runtime-config` uses `externalAgentRuntimeConfigSchema` from [`acp.ts`](../../packages/shared/src/types/api/acp.ts). The owner-only full replacement body contains `idleTimeoutSecs` and `maxAgents`; `maxAgents` is a positive JavaScript safe integer with default `10` and no product-defined upper bound. The value is persisted globally and supplied to the supervised Agentlet daemon as `--max-agents` on its next start; the API does not restart the daemon or configure manually launched remote daemons.

`GET /api/acp/profiles` returns persisted Profiles, active connected devices, connectivity-filtered `selectableProfileIds`, supervised-child health, and optional Agent defaults. `POST /api/acp/profiles` requires an explicit active `agentletId`. `GET /api/acp/agent-cli` requires exactly one explicit target: `agentletId` while creating or `profileId` while editing. The server validates every target against the live Gateway and never substitutes the supervised child or first connected device. Harness commands are compiled by the target Agentlet during spawn; there is no HTTP launch-preview contract.

`PATCH /api/acp/devices/:agentletId` uses the shared `agentletDeviceParamsSchema` and strict `renameAgentletDeviceBodySchema` (`{ displayName }`), returning the normalized body after persistence. It is owner-only and accepts only an exact connected device ID; names are trimmed and limited to 1–120 characters. Invalid input returns 400, disconnected targets return 404, and storage failures return 500 without replacing saved names. `GET /api/acp/profiles` projects persisted names without changing device identity, machine metadata, or Profile aliases; unreadable name storage returns an explicit 500.

## External-agent connection copy

`POST /api/acp/connection-command` is an owner-only, non-cacheable explicit credential reveal. The canonical `agentletConnectionCommandRequestSchema` validates strict `{ origin, shell: "posix" | "powershell", format: "command" | "env-file" }`. Its response is `{ content, source: "environment" | "generated", warnings }`; copy content is a source-daemon invocation or private dotenv data, never an Agentlet token argv flag. Origin mismatch/invalid roots and lossless dotenv encoding failures return explicit 400 errors; operational failures remain 500. The former `GET/PUT /api/acp/connection-token`, update/config wire types, and web helpers are removed; old persisted records are deliberately untouched.

## Utility Agent selection

`GET/PUT /api/agent/defaults` uses `agentDefaultsSchema` for the Utility Agent only: its Profile and optional functional-model override serve Huabu-owned auxiliary work and never choose a conversational binding. The recent conversational Agent is browser-local UI state and has no HTTP contract.

## RFS Agent discovery

`POST /api/rfs/:canvasId/agent/:threadId/ink-intent` uses `rfsInkIntentParamsSchema`, `rfsInkIntentRequestSchema`, and `rfsInkIntentResponseSchema` in `types/api/rfs.ts`, reusing `inkIntentReportSchema`. RFS decodes its raw JSON buffer, validates the target and body with `safeParse`, and delegates to the shared Ink writer. A per-turn invocation token must match the active external turn; inactive, expired, or wrong-scope reports return `409 ink_turn_inactive`. The token is a freshness guard, not a credential; the normal RFS Bearer requirement remains mandatory.

`POST /api/rfs/:canvasId/query` with `type: "INSPECT_NODES"` uses the canonical response contract in [`space-operations.ts`](../../packages/shared/src/types/api/space-operations.ts). Each Question Node result includes its non-empty persisted `threadId` when associated; non-Question Nodes and unbound Questions omit the field. The mapping is scoped by the authenticated RFS URL's Canvas and is read-only: inspection does not create a thread, workload, binding, realization, or invocation. Callers continue the mapped conversation through the existing `POST /api/rfs/:canvasId/agent/:threadId/prompt` SSE endpoint.

## Service Packages

`packages/shared/src/types/api/service-package.ts` defines the strict manifest, Generic Settings update, masked configuration, summary, and External lease contracts. Owner Settings uses `GET /api/services`, `GET /api/services/:serviceId`, and `PUT /api/services/:serviceId`; every path/body value is validated with the shared schemas before selecting a code-registered storage namespace.

Canvas-scoped RFS keeps the existing `/capabilities` path for Space-operation discovery and exposes third-party services under `/services`. Manifest and Skill reads contain no credentials. `POST /services/:id/lease` rejects unknown, unconfigured, and Packages without `SKILL.md`, returns the exact validated Manifest and only its declared configuration fields as one version-coherent runtime context, and is non-cacheable. `GET /download/services/:id.zip` streams the validated `service.yaml + package.files` set beneath one `<serviceId>/` archive root and uses the Package content hash as its ETag. See [`service-packages.md`](./service-packages.md).

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
