// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool Executor — dispatcher only.
 *
 * Each tool's body lives in its own `handlers/<name>.ts` file. This
 * module's job is just:
 *  1. Inject the request-scoped `canvasId` so every canvas-aware
 *     tool runs against the conversation's Space. Read tools may address
 *     canonical World preview targets; writes and snapshots stay bound to
 *     the conversation's Space.
 *  2. Dispatch the call to the matching handler.
 *  3. Return a string result that pi-agent-core wraps into a
 *     `toolResult` content block.
 *
 * Failures throw — pi-agent-core's `executePreparedToolCall` catches
 * them and emits a tool result with `isError: true`, with the thrown
 * `Error.message` as the text content. Handlers MUST NOT encode
 * errors inside the JSON payload.
 *
 * Adding a new tool is a four-step change:
 *  - schema in `./schemas/`
 *  - definition + `*ParamsSchema` in `./definitions.ts`
 *  - body in `./handlers/<name>.ts`
 *  - dispatcher case below
 */

import {
  handleGetCanvasOutline,
  handleInspectEdges,
  handleInspectNodes,
  type GetCanvasOutlineArgs,
  type InspectEdgesArgs,
  type InspectNodesArgs,
} from './handlers/canvas-query.js';
import {
  handleCanvasCommands,
  type CanvasCommandsArgs,
} from './handlers/canvas-write.js';
import { handleRead, type ReadArgs } from './handlers/fs-read.js';
import { normalizeRel } from './handlers/fs-sandbox.js';
import {
  handleFind,
  handleGrep,
  handleLs,
  type FindArgs,
  type GrepArgs,
  type LsArgs,
} from './handlers/fs-search.js';
import { handleFsWrite, type FsWriteArgs } from './handlers/fs-write.js';
import {
  handleGenerateImage,
  type GenerateImageArgs,
} from './handlers/image-generation.js';
import {
  handleReportInkIntent,
  type ReportInkIntentArgs,
} from './handlers/report-ink-intent.js';
import {
  handleSnapshotNodes,
  type SnapshotNodesArgs,
} from './handlers/snapshot-node.js';
import {
  handleCompleteTaskRun,
  handleCreateTask,
  handleStartTaskRun,
  type CompleteTaskRunArgs,
  type CreateTaskArgs,
  type StartTaskRunArgs,
} from './handlers/task.js';
import { handleWebSearch, type WebSearchArgs } from './handlers/web-search.js';
import { resolveWorldReadCanvasId } from '../../canvas/world-target-access.js';
import { callerAccess } from '../../identity/personal-settings.js';
import {
  acquireWorkspaceOperationLease,
  getWorkspaceHandle,
} from '../../workspace.js';

import type { AccessLevel } from '../../identity/service.js';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { NodeOrigin } from '@huabu/shared';

/**
 * Per-request context every handler call receives.
 *
 * - `canvasId` binds every canvas-aware handler to the conversation's Space.
 *   Read tools can resolve an explicit World preview target; write and
 *   snapshot tools retain this binding.
 * - `origin` is forwarded to `canvas_commands` only; other handlers
 *   ignore it. It controls the `NodeOrigin` stamp on AI-generated
 *   nodes (defaults to `'ai-operate'` when unset).
 */
export interface ExecuteContext {
  canvasId?: string;
  origin?: NodeOrigin;
  /** ACP conversation thread to attribute canvas changes to (change card). */
  threadId?: string;
  /**
   * Run-scoped `nodeId → rev` read-set. `read` records the rev of each
   * node it reads; `canvas_commands` reads it to auto-inject `expectRev`
   * on content writes. One Map per `runAgent`; never persisted.
   */
  readSet?: Map<string, string>;
}

/**
 * Execute a tool call and return the result as a string.
 *
 * Per the pi-agent-core `AgentTool.execute` contract, failures throw
 * — the agent loop catches the throw and emits a tool result with
 * `isError: true` (see node_modules/.../pi-agent-core/dist/agent-loop.js
 * `executePreparedToolCall`). Successful calls return a JSON string.
 *
 * @param name    Tool name (matches `ToolDefinition.name`).
 * @param args    Validated tool arguments — already passed pi-ai's
 *                schema check by the time this runs.
 * @param context Per-request context (see `ExecuteContext`).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: ExecuteContext,
): Promise<string | AgentToolResult<unknown>> {
  const requireCanvasId = (toolName: string): string => {
    const canvasId = context?.canvasId;
    if (!canvasId) {
      throw new Error(`canvasId is required for ${toolName}`);
    }
    return canvasId;
  };
  const assertCanvasAccess = async (
    canvasId: string,
    level: AccessLevel,
    allowWorkspaceRead = false,
  ): Promise<void> => {
    // A retained Built-In turn can outlive its HTTP stream and its starter's
    // grants. The conversation binding itself grants no resource authority.
    const access = callerAccess();
    if (!access || (await access.can(level, { type: 'space', id: canvasId })))
      return;
    // Skill files and user memory are Workspace/global instruction layers,
    // also available to a legitimate shared-Space reader. Their reads may use
    // either scope; both decisions freshly enforce membership and disabling.
    const workspaceId =
      level === 'read' && allowWorkspaceRead
        ? getWorkspaceHandle()?.workspaceId
        : undefined;
    if (
      workspaceId &&
      (await access.can('read', { type: 'workspace', id: workspaceId }))
    )
      return;
    throw new Error(
      `Canvas ${canvasId} is not ${level === 'read' ? 'readable' : 'writable'}`,
    );
  };
  const withAuthorizedCanvasId = async <T>(
    value: Record<string, unknown>,
    toolName: string,
    level: AccessLevel,
  ): Promise<T> => {
    const canvasId = requireCanvasId(toolName);
    await assertCanvasAccess(canvasId, level);
    return { ...value, canvasId } as unknown as T;
  };
  const withReadCanvasId = async <T>(
    value: Record<string, unknown>,
    toolName: string,
  ): Promise<T> => {
    const ownerCanvasId = requireCanvasId(toolName);
    const requested = value.targetCanvasId;
    if (requested !== undefined && typeof requested !== 'string') {
      throw new Error('targetCanvasId must be a string');
    }
    const { targetCanvasId: _targetCanvasId, ...toolArgs } = value;
    const canvasId = await resolveWorldReadCanvasId(ownerCanvasId, requested);
    const readPath =
      toolName === 'read' && typeof toolArgs.path === 'string'
        ? normalizeRel(toolArgs.path)
        : undefined;
    // Match handleRead's two virtual paths. Explicit cross-Space targets
    // retain their Space-only authorization even for these instruction files.
    const workspaceInstruction =
      canvasId === ownerCanvasId &&
      (readPath?.startsWith('skills/') || readPath === 'memory/user.md');
    await assertCanvasAccess(canvasId, 'read', workspaceInstruction);
    return { ...toolArgs, canvasId } as unknown as T;
  };
  const withStableWorkspace = async <T>(
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    // Space authorization and the handler that consumes it are one
    // operation. The resolver cannot release the Workspace before the handler
    // runs without reopening a switch window between the check and the read.
    const lease = acquireWorkspaceOperationLease();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  };

  switch (name) {
    case 'report_ink_intent': {
      const canvasId = context?.canvasId;
      if (!canvasId)
        return handleReportInkIntent(args as ReportInkIntentArgs, context);
      // The handler owns active-turn/placeholder rules and resolves whether
      // this report actually touches a Space after acquiring its mutex.
      return withStableWorkspace(() =>
        handleReportInkIntent(args as ReportInkIntentArgs, context, () =>
          assertCanvasAccess(canvasId, 'write'),
        ),
      );
    }

    case 'web_search':
      return handleWebSearch(args as WebSearchArgs);

    case 'get_space_outline':
      return withStableWorkspace(async () =>
        handleGetCanvasOutline(
          await withReadCanvasId<GetCanvasOutlineArgs>(
            args,
            'get_space_outline',
          ),
        ),
      );

    case 'inspect_nodes':
      return withStableWorkspace(async () =>
        handleInspectNodes(
          await withReadCanvasId<InspectNodesArgs>(args, 'inspect_nodes'),
        ),
      );

    case 'inspect_edges':
      return withStableWorkspace(async () =>
        handleInspectEdges(
          await withReadCanvasId<InspectEdgesArgs>(args, 'inspect_edges'),
        ),
      );

    case 'grep':
      return withStableWorkspace(async () =>
        handleGrep(await withReadCanvasId<GrepArgs>(args, 'grep')),
      );

    case 'find':
      return withStableWorkspace(async () =>
        handleFind(await withReadCanvasId<FindArgs>(args, 'find')),
      );

    case 'ls':
      return withStableWorkspace(async () =>
        handleLs(await withReadCanvasId<LsArgs>(args, 'ls')),
      );

    case 'read': {
      const ownerCanvasId = requireCanvasId('read');
      return withStableWorkspace(async () => {
        const readArgs = await withReadCanvasId<ReadArgs>(args, 'read');
        return handleRead(
          readArgs,
          readArgs.canvasId === ownerCanvasId ? context?.readSet : undefined,
        );
      });
    }

    case 'space_commands':
      return withStableWorkspace(async () =>
        handleCanvasCommands(
          await withAuthorizedCanvasId<CanvasCommandsArgs>(
            args,
            'space_commands',
            'write',
          ),
          context?.origin,
          { threadId: context?.threadId, readSet: context?.readSet },
        ),
      );

    case 'create_task':
      return withStableWorkspace(async () =>
        handleCreateTask(
          await withAuthorizedCanvasId<CreateTaskArgs>(
            args,
            'create_task',
            'write',
          ),
        ),
      );

    case 'start_task_run':
      return withStableWorkspace(async () =>
        handleStartTaskRun(
          await withAuthorizedCanvasId<StartTaskRunArgs>(
            args,
            'start_task_run',
            'write',
          ),
        ),
      );

    case 'complete_task_run':
      return withStableWorkspace(async () =>
        handleCompleteTaskRun(
          await withAuthorizedCanvasId<CompleteTaskRunArgs>(
            args,
            'complete_task_run',
            'write',
          ),
        ),
      );

    case 'fs_write':
      // canvasId is conditionally needed (only for memory/space.md);
      // the handler enforces that. Pass it through when present so the
      // handler can resolve canvas-scoped paths, but do not require it
      // here — workspace and skill writes have no canvas binding.
      return handleFsWrite({
        ...args,
        canvasId: context?.canvasId,
      } as FsWriteArgs);

    case 'snapshot_nodes':
      return withStableWorkspace(async () =>
        handleSnapshotNodes(
          await withAuthorizedCanvasId<SnapshotNodesArgs>(
            args,
            'snapshot_nodes',
            'read',
          ),
        ),
      );

    case 'generate_image':
      return withStableWorkspace(async () =>
        handleGenerateImage(
          await withAuthorizedCanvasId<GenerateImageArgs>(
            args,
            'generate_image',
            'write',
          ),
        ),
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
