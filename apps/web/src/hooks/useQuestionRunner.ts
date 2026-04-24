/**
 * Hook that manages the execution lifecycle of question nodes.
 *
 * Watches for question nodes with status==='pending' whose runAt has
 * expired, then sends the question + spatial context to the existing
 * /api/agent endpoint and updates node status throughout.
 *
 * Mount once in the Canvas component — it is canvas-scoped.
 */

import {
  buildQuestionNodeContext,
  createId,
  type QuestionSpatialContext,
  type SpatialNode,
} from '@sediment/shared';
import { useEffect, useRef } from 'react';

import { agentApi } from '@/api/agent';
import useCanvasStore, { getCachedSpatialData } from '@/store/canvasStore';

// ── Serialise spatial context to natural-language text ──────────

function serializeSpatialContext(ctx: QuestionSpatialContext): string {
  const sections: string[] = [];

  sections.push(`### Spatial Position\n\n${ctx.semanticPosition}`);

  for (const layer of ctx.layers) {
    const heading = layer.frameLabel
      ? `### Inside "${layer.frameLabel}" frame`
      : '### Canvas Level';
    const groups = layer.groups
      .map((g) => {
        const dir =
          g.dx === 0 && g.dy === 0
            ? 'overlapping'
            : g.dy < -50
              ? 'above'
              : g.dy > 50
                ? 'below'
                : g.dx < 0
                  ? 'to the left'
                  : 'to the right';
        const nodeLines = g.nodes
          .map(
            (n) =>
              `- "${n.label ?? n.id}" [${n.type ?? 'unknown'}]${n.snippet ? ` — ${n.snippet}` : ''}`,
          )
          .join('\n');
        return `**${dir}** (${g.arrangement}):\n${nodeLines}`;
      })
      .join('\n\n');
    sections.push(`${heading}\n\n${groups}`);
  }

  if (ctx.relevantEdges.length > 0) {
    const edgeLines = ctx.relevantEdges
      .map(
        (e) =>
          `- "${e.sourceLabel ?? e.source}" → "${e.targetLabel ?? e.target}"`,
      )
      .join('\n');
    sections.push(`### Connections\n\n${edgeLines}`);
  }

  return sections.join('\n\n');
}

// ── Build the text that gets injected as [SYSTEM Context] ──────

function buildContextMessage(
  question: string,
  spatialCtx: QuestionSpatialContext,
): {
  content: string;
} {
  const spatial = serializeSpatialContext(spatialCtx);

  const content = [
    '[SYSTEM Context]',
    '## Question Node Context',
    '',
    `### Your Question\n\n"${question}"`,
    '',
    spatial,
  ].join('\n');

  return { content };
}

// ── Active run tracking (abort on cancel / node delete) ────────

const activeRuns = new Map<string, AbortController>();

/** Abort and clean up a question node run. */
function abortRun(nodeId: string): void {
  const ac = activeRuns.get(nodeId);
  if (ac) {
    ac.abort();
    activeRuns.delete(nodeId);
  }
}

// ── Core execution function ────────────────────────────────────

async function executeQuestionNode(nodeId: string): Promise<void> {
  const state = useCanvasStore.getState();
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const data = node.data as Record<string, unknown>;
  const input = data.input as { kind: string; content?: string } | undefined;
  const question =
    input?.kind === 'text' ? ((input.content as string) ?? '') : '';
  if (!question.trim()) return;

  const canvasId = state.canvasId;
  const patch = state.patchNodeSilent;

  // Generate or reuse thread ID
  let threadId = data.threadId as string | undefined;
  if (!threadId) {
    threadId = createId('thread');
    patch(nodeId, { threadId });
  }

  // Set running (reset viewed so the glow re-appears on completion)
  patch(nodeId, { status: 'running', errorMessage: undefined, viewed: false });

  // Abort controller
  const abortController = new AbortController();
  activeRuns.set(nodeId, abortController);

  try {
    // Build spatial context
    const { spatialNodes } = getCachedSpatialData();
    const target = spatialNodes.find((n: SpatialNode) => n.id === nodeId);

    let spatialCtx: QuestionSpatialContext | undefined;
    if (target) {
      const edges = state.edges.map((e) => ({
        source: e.source,
        target: e.target,
      }));
      const snippets = new Map<string, string>();
      for (const n of state.nodes) {
        const d = n.data as Record<string, unknown> | undefined;
        const snippet =
          (d?.label as string) ??
          (d?.content as string)?.slice(0, 120) ??
          (d?.src as string) ??
          '';
        if (snippet) snippets.set(n.id, snippet);
      }
      spatialCtx = buildQuestionNodeContext(
        target,
        spatialNodes,
        edges,
        snippets,
      );
    }

    // Build context message (injected before user message on server)
    const contextMsg = spatialCtx
      ? buildContextMessage(question, spatialCtx)
      : undefined;

    // The actual user message is just the question.
    // Spatial context is prepended so buildHistoryItems strips it (starts with [SYSTEM).
    const messageContent = contextMsg
      ? `${contextMsg.content}\n\n${question}`
      : question;

    // Stream to existing /api/agent endpoint
    await agentApi.streamMessage(
      messageContent,
      threadId,
      'ask',
      {
        onEvent: () => {
          // Events stream in background — we don't render them live.
          // The conversation is viewed later via openQuestionThread.
        },
        onError: (err) => {
          if (!abortController.signal.aborted) {
            patch(nodeId, {
              status: 'error',
              errorMessage: err.message,
            });
          }
          activeRuns.delete(nodeId);
        },
        onComplete: () => {
          if (!abortController.signal.aborted) {
            patch(nodeId, { status: 'done' });
          }
          activeRuns.delete(nodeId);
        },
      },
      {
        canvasId,
        signal: abortController.signal,
      },
    );
  } catch (err) {
    if (!abortController.signal.aborted) {
      patch(nodeId, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
    }
    activeRuns.delete(nodeId);
  }
}

// ── Hook ───────────────────────────────────────────────────────

export function useQuestionRunner(): void {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    // Track which question nodes we already know about to avoid re-scanning
    // unchanged nodes on every unrelated store update.
    const knownStates = new Map<string, { status: string; runAt?: number }>();

    // Subscribe to store changes — watch question nodes
    const unsub = useCanvasStore.subscribe((state, prev) => {
      const nodes = state.nodes;
      const prevNodes = prev.nodes;

      // Only react if node list reference changed
      if (nodes === prevNodes) return;

      // Build a set of current question node IDs for cleanup.
      const currentQuestionIds = new Set<string>();

      for (const node of nodes) {
        const data = node.data as Record<string, unknown>;
        if (data.type !== 'question') continue;

        const status = data.status as string;
        const runAt = data.runAt as number | undefined;
        const nodeId = node.id;
        currentQuestionIds.add(nodeId);

        // Skip if nothing changed for this node.
        const prev = knownStates.get(nodeId);
        if (prev && prev.status === status && prev.runAt === runAt) continue;
        knownStates.set(nodeId, { status, runAt });

        if (status === 'pending' && runAt) {
          // Already has a timer? Skip.
          if (timersRef.current.has(nodeId)) continue;

          const delay = Math.max(0, runAt - Date.now());
          const timer = setTimeout(() => {
            timersRef.current.delete(nodeId);
            // Re-check status before executing
            const current = useCanvasStore
              .getState()
              .nodes.find((n) => n.id === nodeId);
            const currentData = current?.data as
              | Record<string, unknown>
              | undefined;
            if (currentData?.status === 'pending') {
              void executeQuestionNode(nodeId);
            }
          }, delay);
          timersRef.current.set(nodeId, timer);
        } else if (
          status === 'idle' ||
          status === 'done' ||
          status === 'error'
        ) {
          // Cancel if timer exists (user cancelled or status changed)
          const timer = timersRef.current.get(nodeId);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(nodeId);
          }
          // Abort active run if user cancelled to idle
          if (status === 'idle') {
            abortRun(nodeId);
          }
        }
      }

      // Clean up timers for deleted question nodes
      for (const nodeId of timersRef.current.keys()) {
        if (!currentQuestionIds.has(nodeId)) {
          const t = timersRef.current.get(nodeId);
          if (t) clearTimeout(t);
          timersRef.current.delete(nodeId);
          knownStates.delete(nodeId);
          abortRun(nodeId);
        }
      }
    });

    const timers = timersRef.current;
    return () => {
      unsub();
      // Clean up all timers and active runs
      for (const [nodeId, timer] of timers) {
        clearTimeout(timer);
        abortRun(nodeId);
      }
      timers.clear();
    };
  }, []);
}
