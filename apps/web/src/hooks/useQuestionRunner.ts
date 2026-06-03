/**
 * Hook that manages the execution lifecycle of question nodes.
 *
 * Watches for question nodes with status==='pending' whose runAt has
 * expired, then sends the question (plus the node id, so the server
 * can resolve its spatial neighbourhood from `canvas.json`) to the
 * `/api/agent` endpoint and updates node status throughout.
 *
 * Mount once in the Canvas component — it is canvas-scoped.
 */

import { createId } from '@sediment/shared';
import { useEffect, useRef } from 'react';

import type { AgentBinding, AgentMode } from '@sediment/shared';

import { agentApi } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';

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

  // Resolve the binding chosen via the in-node `@` mention. Defaults
  // (internal binding + `ask` mode) preserve the legacy behaviour for
  // question nodes created before the picker existed.
  const agentBinding = data.agentBinding as AgentBinding | undefined;
  const explicitMode = data.agentMode as AgentMode | undefined;
  const mode: AgentMode =
    agentBinding?.kind === 'external' ? 'ask' : (explicitMode ?? 'ask');

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

  // Track whether the stream delivered a usable final `done` event.
  // The agent server can emit an `error` event *after* a successful
  // `done` (e.g. on cap-out: `Agent loop exceeded maximum iterations`),
  // and the user reasonably expects "received a final answer" to mean
  // the node displays success — not error — regardless of mid-run tool
  // failures or the soft turn cap.
  let sawDone = false;

  try {
    // Stream to existing /api/agent endpoint.
    //
    // The user message is just the bare question. The server resolves
    // the question node's neighbourhood from `canvas.json` (see
    // `getNodeNeighbourhood` / `renderNodeNeighbourhoodMarkdown`) and
    // prepends a `[SYSTEM Context]` preamble rendered from the Ask
    // agent's `nodeNeighbourhoodPreamble` template — so neither the
    // prompt wording nor the spatial graph travels through the
    // frontend.
    await agentApi.streamMessage(
      question,
      threadId,
      mode,
      {
        onEvent: (event) => {
          if (event.type === 'done') sawDone = true;
          // Events stream in background — we don't render them live.
          // The conversation is viewed later via openQuestionThread.
        },
        onError: (err) => {
          if (!abortController.signal.aborted) {
            if (sawDone) {
              // A final answer was delivered before this error — treat
              // the run as successful so the node shows the unviewed
              // glow instead of a red error badge.
              patch(nodeId, { status: 'done', errorMessage: undefined });
            } else {
              patch(nodeId, {
                status: 'error',
                errorMessage: err.message,
              });
            }
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
        anchorNodeId: nodeId,
        agentBinding,
        signal: abortController.signal,
      },
    );
  } catch (err) {
    if (!abortController.signal.aborted) {
      if (sawDone) {
        patch(nodeId, { status: 'done', errorMessage: undefined });
      } else {
        patch(nodeId, {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        });
      }
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
