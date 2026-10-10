// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Agent API wire schemas.
 *
 * Validation contracts for the unified `/api/agent` endpoint and its
 * sibling routes (chat history, context tokens). Per
 * docs/architecture/api-design.md: schemas are the single source of truth,
 * types derived via `z.infer`.
 *
 * Wire-only node payloads (`WireNodeRef` / `WireSelectionNode` /
 * `WireCanvasNode`) and the request envelope that wraps them
 * (`AgentChatContext`) have explicit zod schemas so every public HTTP
 * boundary gets field-level validation — no payload reaches business logic
 * via a trust-the-caller `z.custom`.
 */

import { z } from 'zod';

import { REASONING_EFFORT_VALUES } from './llm.js';
import {
  INK_INTERPRETATION_TEXT_LIMIT,
  INK_INTERPRETATION_EXPLANATION_LIMIT,
} from '../../utils/ink-interpretation.js';
import { CANVAS_NODE_TYPES } from '../canvas/node.js';

import type { AgentBinding } from './acp.js';
import type { AgentChatContext } from '../agent/index.js';

// ─── Wire-only node payloads ──────────────────────────────────────────────
//
// Wire shapes posted from the web client to `/api/agent`.
// Deliberately thin: only **raw canvas state**
// (id / type / label / content / src / parentId / position / size)
// crosses the wire — no server-side enrichment fields like
// `filename` (storage convention), `preview` (prompt formatting), or
// `parentFrame.label` (server-side lookup). The server enriches into
// `AgentNodeRef` / `AgentNodePreview` / `AgentNodeOutline` as needed
// before any prompt rendering.
//
// Keeping the wire payload thin means changing the LLM-facing prompt
// shape (preview length, filename rule, opt-in fields) does not
// require a frontend deploy.

const positionSchema = z.object({ x: z.number(), y: z.number() });
const sizeSchema = z.object({
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

/** Bare node identity payload — every wire ref starts here. */
export const wireNodeRefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(CANVAS_NODE_TYPES),
  label: z.string().optional(),
});
export type WireNodeRef = z.infer<typeof wireNodeRefSchema>;

/**
 * Selection wire shape posted from the web client to `/api/agent`.
 *
 * Two things make this distinct from {@link WireNodeRef}:
 *
 *  1. **Recursive `children`** — frame nodes carry their direct
 *     children so the server can flatten the selection without a
 *     follow-up canvas read.
 *  2. **`src` for image nodes** — the server uses it to build
 *     vision attachments before the LLM ever sees the selection.
 *
 * The server normalises this into `AgentNodeRef[]` server-side
 * before any prompt rendering. Never sent to the LLM directly.
 */
export interface WireSelectionNode extends WireNodeRef {
  /** Source URL — only present for `type === 'image'`. */
  src?: string;
  /**
   * Partial stroke selection — only present for `type === 'sketch'`
   * when the user lassoed a SUBSET of the node's strokes (Stage 2
   * stroke selection) rather than the whole node. Ids are stable
   * `SketchStroke.id`s. Absent = the whole sketch is in scope. The
   * server threads this into the auto-snapshot as a `strokeSubsets`
   * entry and marks the node's context ref as a partial selection.
   */
  strokeIds?: string[];
  /** Direct frame children; undefined for non-frame nodes. */
  children?: WireSelectionNode[];
}

export const wireSelectionNodeSchema: z.ZodType<WireSelectionNode> = z.lazy(
  () =>
    z.object({
      id: z.string().min(1),
      type: z.enum(CANVAS_NODE_TYPES),
      label: z.string().optional(),
      src: z.string().optional(),
      strokeIds: z.array(z.string()).optional(),
      children: z.array(wireSelectionNodeSchema).optional(),
    }),
);

/**
 * Wire shape for one node inside a full canvas snapshot. Carries the raw
 * canvas-state fields the server needs to enrich into an
 * `AgentNodeOutline`:
 *
 *  - `content` / `src`  — fed into the preview ladder server-side
 *  - `parentId`         — server resolves into `parentFrame.label`
 *  - `position` / `size` — already resolved to absolute coords by web
 *
 * Deliberately **does not** carry `filename`, `preview`, or
 * `parentFrame.label` — those are server-side decisions.
 */
export const wireCanvasNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(CANVAS_NODE_TYPES),
  label: z.string().optional(),
  /** Inline node body (markdown / plain text), when present. */
  content: z.string().optional(),
  /** Source URL — meaningful for image / pdf / web / video nodes. */
  src: z.string().optional(),
  /** Parent frame id (web has already done absolute-position resolution). */
  parentId: z.string().optional(),
  /** Absolute position on canvas (top-left corner). */
  position: positionSchema,
  /** Effective dimensions (measured > styled > 0 fallback). */
  size: sizeSchema,
});
export type WireCanvasNode = z.infer<typeof wireCanvasNodeSchema>;

/** A single attachment carried with a chat message. */
export const chatAttachmentSchema = z.object({
  type: z.enum(['image', 'pdf', 'text', 'file', 'web']),
  source: z.enum(['upload', 'excerpt', 'selection']),
  /**
   * Single source node — used for 1:1 attachments (PDF excerpt, text
   * selection, image node send-to-chat). The chat UI renders a
   * clickable badge linking back to this node.
   */
  originNodeId: z.string().optional(),
  /**
   * Multiple source nodes — used for attachments derived from a group
   * of nodes (e.g. one image rendered from a sketch cluster of N
   * strokes). Coexists with `originNodeId`; consumers that only
   * understand the singular field still get a clickable badge for the
   * primary node, while `originNodeIds` carries the full set for the
   * agent and for richer UI rendering.
   */
  originNodeIds: z.array(z.string()).optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  label: z.string().optional(),
  filename: z.string().optional(),
});

// ─── Request-context schemas ──────────────────────────────────────────────
//
// Field-level validator for the `canvasContext` envelope posted to
// `/api/agent`. Carries only wire shapes (above) plus pre-existing schemas
// — no runtime dependency on the rich TS interfaces in `agent/context.ts`.
// The `satisfies` check below pins the schema against the canonical TS
// interface so any drift fails the build.

/** Wire shape of {@link AgentChatContext}. */
export const agentChatContextSchema = z.object({
  selectedNodes: z.array(wireSelectionNodeSchema),
}) satisfies z.ZodType<AgentChatContext>;

/**
 * Wire shape of {@link AgentBinding}.
 * Discriminated union: `kind: 'internal'` (default) routes to the built-in
 * agent; `kind: 'external'` routes to the ACP service via a configured
 * profile id. See acp.ts.
 */
export const agentBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('internal') }),
  z.object({
    kind: z.literal('external'),
    alias: z.string().min(1),
    profileId: z.string().min(1),
  }),
]) satisfies z.ZodType<AgentBinding>;

export const agentInputKindSchema = z.enum(['text', 'ink-intent']);
export type AgentInputKind = z.infer<typeof agentInputKindSchema>;

const inkInterpretationTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(INK_INTERPRETATION_TEXT_LIMIT)
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'Ink interpretation must be one line',
  });
export const inkIntentReportSchema = z.strictObject({
  text: inkInterpretationTextSchema,
  explanation: z
    .string()
    .trim()
    .min(1)
    .max(INK_INTERPRETATION_EXPLANATION_LIMIT)
    .optional(),
});
export type InkIntentReport = z.infer<typeof inkIntentReportSchema>;

/** Host-owned delivery state, not an Agent-authored semantic classification. */
export const inkInterpretationSchema = z.discriminatedUnion('state', [
  inkIntentReportSchema.extend({ state: z.literal('reported') }),
  z.object({
    state: z.enum(['pending', 'missing', 'failed', 'interrupted', 'legacy']),
  }),
]);
export type InkInterpretation = z.infer<typeof inkInterpretationSchema>;

const finiteNumberSchema = z.number().finite();
const positiveNumberSchema = finiteNumberSchema.positive();
const canvasRectSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: positiveNumberSchema,
  height: positiveNumberSchema,
});

export const visibleCanvasGroundingSchema = z.object({
  kind: z.literal('visible-canvas'),
  dataUrl: z
    .string()
    .min(1)
    .max(750_000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
  viewport: z.object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    zoom: positiveNumberSchema,
    width: positiveNumberSchema,
    height: positiveNumberSchema,
    devicePixelRatio: positiveNumberSchema,
  }),
  crop: canvasRectSchema,
  selectedNodeIds: z
    .array(z.string().min(1))
    .max(200)
    .refine((values) => new Set(values).size === values.length, {
      message: 'Grounding node IDs must be unique',
    }),
  strokeSubsets: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        strokeIds: z
          .array(z.string().min(1))
          .min(1)
          .max(10_000)
          .refine((values) => new Set(values).size === values.length, {
            message: 'Grounding stroke IDs must be unique',
          }),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (subsets) =>
        new Set(subsets.map((subset) => subset.nodeId)).size === subsets.length,
      { message: 'Grounding stroke nodes must be unique' },
    ),
});
export type VisibleCanvasGrounding = z.infer<
  typeof visibleCanvasGroundingSchema
>;

function hasPartialSketchSelection(nodes: WireSelectionNode[]): boolean {
  return nodes.some(
    (node) =>
      (node.type === 'sketch' &&
        !!node.strokeIds?.length &&
        node.strokeIds.every((strokeId) => strokeId.trim().length > 0)) ||
      (node.type === 'frame' && hasPartialSketchSelection(node.children ?? [])),
  );
}

function selectedGroundingOperands(nodes: WireSelectionNode[]): {
  ordinaryNodeIds: string[];
  strokeSubsets: Array<{ nodeId: string; strokeIds: string[] }>;
} {
  const ordinaryNodeIds: string[] = [];
  const strokeSubsets: Array<{ nodeId: string; strokeIds: string[] }> = [];
  const collect = (values: WireSelectionNode[], topLevel: boolean): void => {
    for (const node of values) {
      if (node.type === 'sketch' && node.strokeIds?.length) {
        strokeSubsets.push({ nodeId: node.id, strokeIds: [...node.strokeIds] });
      } else if (topLevel && node.type !== 'question') {
        ordinaryNodeIds.push(node.id);
      }
      if (node.children?.length) collect(node.children, false);
    }
  };
  collect(nodes, true);
  return { ordinaryNodeIds, strokeSubsets };
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

/** Body for `POST /api/agent`. */
export const agentRequestSchema = z
  .object({
    inputKind: agentInputKindSchema.optional(),
    content: z.string(),
    threadId: z.string().min(1).optional(),
    mode: z.enum(['ask', 'operate']).optional(),
    canvasContext: agentChatContextSchema.optional(),
    canvasId: z.string().min(1).optional(),
    attachments: z.array(chatAttachmentSchema).optional(),
    groundingVisual: visibleCanvasGroundingSchema.optional(),
    /**
     * Anchor a node-neighbourhood preamble to this node id. When set,
     * the server resolves the node's surrounding-canvas context (see
     * `getNodeNeighbourhood` / `renderNodeNeighbourhoodMarkdown`) and
     * pushes a `[SYSTEM Context]` preamble — rendered from the Ask
     * agent's `nodeNeighbourhoodPreamble` template — before the actual
     * user message. Sent today by `useQuestionRunner` so the prompt
     * wording and the (potentially large) spatial graph stay off the
     * wire and out of the frontend bundle. Anchor-type agnostic; can
     * back any future "describe what's around X" flow.
     */
    anchorNodeId: z.string().min(1).optional(),
    /**
     * Thread-level agent binding. When omitted or `{ kind: 'internal' }`
     * the request is dispatched to Huabu's built-in agent loop
     * (`runAgent`). When `{ kind: 'external', alias, profileId }`
     * the request is dispatched to the ACP service, which resolves the
     * profile to a live agent (spawning one via the daemon if needed).
     * Carried per-request so the server is stateless about thread bindings;
     * the persistent ChatStore on the client is the source of truth.
     */
    agentBinding: agentBindingSchema.optional(),
    /**
     * User-invoked skill ids parsed from leading `/<id>` tokens in the
     * chat input (see `useInternalSlashCommands` on the web side). The
     * server fetches each skill's body and prepends a dedicated SYSTEM
     * preamble for this turn, forcing the agent to apply the skill
     * instead of relying on it to discover the skill via the catalogue.
     *
     * Mirrors Claude Code's "explicitly invoked skill" semantics: when
     * the user types `/canvas-memory`, the corresponding SKILL.md body
     * is guaranteed to be in context.
     *
     * Server-side rules:
     *  - Only `user` / `merged` skills are honoured. Unknown or
     *    system-only ids are dropped silently (with a log line) so a
     *    stale client cannot smuggle system skills into the turn.
     *  - Capped at 8 to keep the context budget sane.
     */
    invokedSkills: z.array(z.string().min(1)).max(8).optional(),
    /**
     * Built-in agent per-thread capability selection carried with this
     * turn. Lets the client apply a model / reasoning-effort picked before
     * the thread's first message (when the per-thread settings endpoints
     * have no persisted record to target yet). Ignored for external (ACP)
     * bindings. `reasoningEffort` accepts pi thinking levels plus `off`
     * (the "Auto" / model-default choice).
     */
    modelId: z.string().min(1).optional(),
    reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  })
  .superRefine((request, context) => {
    if (request.inputKind !== 'ink-intent') {
      if (request.groundingVisual) {
        context.addIssue({
          code: 'custom',
          path: ['groundingVisual'],
          message: 'Visible Canvas grounding is only valid for Ink requests',
        });
      }
      if (request.content.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['content'],
          message: 'Message content is required',
        });
      }
      return;
    }
    if (
      !request.canvasId ||
      !hasPartialSketchSelection(request.canvasContext?.selectedNodes ?? [])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['canvasContext'],
        message: 'Ink requests require a Canvas and selected Sketch strokes',
      });
    }
    const operands = selectedGroundingOperands(
      request.canvasContext?.selectedNodes ?? [],
    );
    if (operands.ordinaryNodeIds.length > 0 && !request.groundingVisual) {
      context.addIssue({
        code: 'custom',
        path: ['groundingVisual'],
        message: 'Mixed Ink requests require visible Canvas grounding',
      });
    }
    if (request.groundingVisual) {
      const groundingStrokes = new Map(
        request.groundingVisual.strokeSubsets.map((subset) => [
          subset.nodeId,
          subset.strokeIds,
        ]),
      );
      const strokesMatch =
        groundingStrokes.size === operands.strokeSubsets.length &&
        operands.strokeSubsets.every((subset) =>
          sameStringSet(
            subset.strokeIds,
            groundingStrokes.get(subset.nodeId) ?? [],
          ),
        );
      if (
        !sameStringSet(
          operands.ordinaryNodeIds,
          request.groundingVisual.selectedNodeIds,
        ) ||
        !strokesMatch
      ) {
        context.addIssue({
          code: 'custom',
          path: ['groundingVisual'],
          message: 'Visible Canvas grounding does not match the selection',
        });
      }
    }
  });
export type AgentRequest = z.infer<typeof agentRequestSchema>;

/** Querystring for `GET /api/agent/history` and `/api/agent/context-tokens`. */
export const agentCanvasIdQuerySchema = z.object({
  canvasId: z.string().min(1).optional(),
});
export type AgentCanvasIdQuery = z.infer<typeof agentCanvasIdQuerySchema>;

/**
 * Body for `POST /api/agent/history/:threadId/fork`.
 *
 * Forks a thread's conversation onto a brand-new thread id so a copied
 * question node owns an independent continuation that nonetheless starts
 * from the same history. The `canvasId` query selects the SOURCE canvas;
 * `targetCanvasId` (when set) lets a cross-canvas paste land the copy on
 * a different canvas. Both built-in and external agents fork from the
 * driver-agnostic materialized source history; each target driver chooses how
 * to load completed turns plus an optional incomplete tail projection.
 */
export const forkThreadBodySchema = z.object({
  targetThreadId: z.string().min(1),
  targetCanvasId: z.string().min(1).optional(),
});
export type ForkThreadBody = z.infer<typeof forkThreadBodySchema>;

export interface ForkThreadResponse {
  /** The new thread id realized from the source history. */
  threadId: string;
  /** False when the source thread had no persisted history to copy. */
  forked: boolean;
}

export const agentTurnAcceptedSchema = z.object({
  threadId: z.string().min(1),
  turnStartSeq: z.number().int().positive(),
});
export type AgentTurnAccepted = z.infer<typeof agentTurnAcceptedSchema>;

export const stopThreadResponseSchema = z.object({
  stopped: z.boolean(),
  acceptance: agentTurnAcceptedSchema.nullable(),
});
export type StopThreadResponse = z.infer<typeof stopThreadResponseSchema>;
