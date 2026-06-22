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

import { useEffect, useRef } from 'react';

import { createId } from '@sediment/shared';

import { agentApi } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

import { applyCanvasCommandsFromToolResult } from './useAgentStream';

import type { AgentBinding, AgentMode } from '@sediment/shared';

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

/**
 * Claim terminal ownership of a finishing run.
 *
 * Returns `true` (and removes the run from {@link activeRuns}) only when
 * `controller` is still the node's registered run — i.e. THIS run is the
 * one allowed to write a terminal status. Returns `false` when:
 *
 *   - the user cancelled the run (the store subscriber demoted the node
 *     to `idle` and `abortRun` already deleted the entry), or
 *   - a newer run superseded this one (re-run replaced the entry), or
 *   - the node was deleted.
 *
 * Replaces the previous `!signal.aborted` guard, which left the node
 * stranded at `running` whenever the stream ended via an abort that was
 * NOT a deliberate user cancel — `streamMessage` still fires
 * `onComplete` on abort, but the old guard then skipped the terminal
 * patch. Keying on run ownership instead terminalizes in every case
 * except the ones above, so a question node can never stall at
 * `running` after its stream actually finishes.
 */
function claimRunCompletion(
  nodeId: string,
  controller: AbortController,
): boolean {
  if (activeRuns.get(nodeId) !== controller) return false;
  activeRuns.delete(nodeId);
  return true;
}

// ── Core execution function ────────────────────────────────────

async function executeQuestionNode(nodeId: string): Promise<void> {
  const state = useCanvasStore.getState();
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const data = node.data as Record<string, unknown>;
  const question = typeof data.content === 'string' ? data.content : '';
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

  // Per-run map of toolCallId → toolName, populated from `tool_call`
  // events. We need it on `tool_call_update` because the update event
  // itself doesn't carry the tool name — same trick the chat panel
  // uses (recovered from the prior tool part there, kept local here
  // since the question runner doesn't materialise messages).
  const toolNamesByCallId = new Map<string, string>();

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
          if (event.type === 'done') {
            sawDone = true;
            return;
          }
          // Track tool names so we can identify canvas_commands results
          // on the matching tool_call_update. The wire field is
          // `internalToolName` (NOT `toolName`) — it's the
          // discriminator the server stamps on internal-agent turns;
          // external ACP turns leave it undefined and we ignore them.
          if (event.type === 'tool_call') {
            const d = event.data as {
              toolCallId?: string;
              internalToolName?: string;
            };
            if (d.toolCallId && d.internalToolName) {
              toolNamesByCallId.set(d.toolCallId, d.internalToolName);
            }
            return;
          }
          // Apply canvas_commands tool results to the local store so
          // the open tab reflects the agent's edits live (without this
          // the canvas only updates after a page refresh). Crucially,
          // this also bumps the local `version` to match the server's
          // `toVersion` — without that, the subsequent `status=done`
          // patch's autosave PUT 409s, the conflict toast appears, and
          // every later question-node status update silently fails too.
          if (event.type === 'tool_call_update') {
            const d = event.data as {
              toolCallId?: string;
              rawOutput?: unknown;
            };
            if (!d.toolCallId || d.rawOutput === undefined) return;
            const toolName = toolNamesByCallId.get(d.toolCallId);
            if (toolName !== 'canvas_commands') return;
            const rawText =
              typeof d.rawOutput === 'string'
                ? d.rawOutput
                : JSON.stringify(d.rawOutput);
            applyCanvasCommandsFromToolResult(rawText);
            return;
          }
          // Other events (text_delta / thinking_delta / plan / meta /
          // session_*) stream in background — we don't render them
          // live; the conversation is viewed later via
          // openQuestionThread.
        },
        onError: (err) => {
          if (!claimRunCompletion(nodeId, abortController)) return;
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
        },
        onComplete: () => {
          if (!claimRunCompletion(nodeId, abortController)) return;
          // If the user is currently watching this question's thread
          // in the chat panel at completion time, mark `viewed: true`
          // so the "done · unread" glow doesn't fire (they watched
          // it stream live). Otherwise leave `viewed` as the runner
          // set it (false) so the glow surfaces when they next look.
          const stillViewing =
            useChatStore.getState().viewingQuestionThread?.nodeId === nodeId;
          patch(nodeId, {
            status: 'done',
            ...(stillViewing ? { viewed: true } : {}),
          });
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
    if (!claimRunCompletion(nodeId, abortController)) return;
    if (sawDone) {
      patch(nodeId, { status: 'done', errorMessage: undefined });
    } else {
      patch(nodeId, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
    }
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
          // A timer may already exist from a prior `runAt` (the typical
          // shape: edit auto-arms a 10s countdown, then the user
          // presses the "Run now" Play button which patches
          // `runAt: Date.now()` to fire immediately). The old timer is
          // pinned to the OLD `runAt`, so blindly skipping when a
          // timer exists would leave "Run now" waiting out the
          // original countdown — and during that wait `status` stays
          // `pending`, so a double-click would fall into the
          // "idle/pending → edit mode" branch instead of opening the
          // chat. Always clear-and-reschedule so the active timer
          // tracks the latest `runAt`.
          const existing = timersRef.current.get(nodeId);
          if (existing) clearTimeout(existing);

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
