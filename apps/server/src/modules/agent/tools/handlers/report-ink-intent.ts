// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { inkIntentReportSchema } from '@huabu/shared';

import { executeOnServerAlreadyLocked } from '../../../canvas/canvas-executor.js';
import { withCanvasMutex } from '../../../canvas/write-coordinator.js';
import { space } from '../../../storage/index.js';
import {
  activeInkIntentOwnerNodeId,
  isActiveExternalInkIntentTurn,
  isActiveInkIntentTurn,
  publishExternalInkReport,
} from '../../ink-intent-runtime.js';

import type {
  CanvasCommand,
  CanvasNodeId,
  InkIntentReport,
  RfsInkIntentResponse,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

export type ReportInkIntentArgs = InkIntentReport;

const INK_PLACEHOLDER_LABEL = 'New ink request';

export class InkIntentTurnError extends Error {
  readonly code = 'ink_turn_inactive';
  constructor() {
    super('Ink reports are available only during the matching active Ink turn');
  }
}

async function settlePendingInkQuestion(
  canvasId: string,
  threadId: string,
  text?: string,
  invocationToken?: string,
  authorizeSpaceMutation?: () => Promise<void>,
): Promise<boolean> {
  const assertActive = () => {
    if (
      invocationToken !== undefined
        ? !isActiveExternalInkIntentTurn(canvasId, threadId, invocationToken)
        : !isActiveInkIntentTurn(canvasId, threadId)
    ) {
      throw new InkIntentTurnError();
    }
  };
  return withCanvasMutex(canvasId, async () => {
    assertActive();
    const ownerNodeId = activeInkIntentOwnerNodeId(canvasId, threadId);
    if (!ownerNodeId) return false;
    // The owner can appear while this call waits for the Canvas mutex. The
    // dispatcher checks current rights here, before any Space data is read,
    // while a no-owner report remains a stateless payload validation.
    await authorizeSpaceMutation?.();
    const handle = space(canvasId);
    const canvas = await handle.read();
    if (!canvas) return false;
    const node = (canvas.state.nodes as CanvasNode[]).find(
      (candidate) => candidate.id === ownerNodeId,
    );
    if (node?.type !== 'question' || node.data.threadId !== threadId)
      return false;
    if (node?.data.pendingInkIntentLabel !== true) return false;
    const record = (await handle.nodes.read(node.id))?.record;
    const canRename =
      text !== undefined &&
      (record?.label === INK_PLACEHOLDER_LABEL ||
        record?.label === 'New selection request') &&
      record.labelSource !== 'user';
    assertActive();
    const command: CanvasCommand = {
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: node.id as CanvasNodeId,
          patch: {
            ...(canRename
              ? { label: text, labelSource: 'agent' as const }
              : {}),
            pendingInkIntentLabel: false,
          },
        },
      ],
    };
    const output = await executeOnServerAlreadyLocked({
      canvasId,
      commands: [command],
      originator: { source: 'agent', threadId },
    });
    if (output.results[0]?.applied !== true) {
      throw new Error('Failed to settle the pending Ink Question');
    }
    return canRename;
  });
}

/**
 * Validate an Ink report and settle its Question when an active turn owns one.
 * The trusted caller may supply `authorizeSpaceMutation` to enforce current
 * Space rights at the actual sidecar branch, after mutex/owner resolution.
 */
export async function reportInkIntent(
  args: ReportInkIntentArgs,
  context: { canvasId: string; threadId: string; invocationToken?: string },
  authorizeSpaceMutation?: () => Promise<void>,
): Promise<RfsInkIntentResponse> {
  const report = inkIntentReportSchema.parse(args);
  const renamed = await settlePendingInkQuestion(
    context.canvasId,
    context.threadId,
    report.text,
    context.invocationToken,
    authorizeSpaceMutation,
  );
  if (
    context.invocationToken &&
    !isActiveExternalInkIntentTurn(
      context.canvasId,
      context.threadId,
      context.invocationToken,
    )
  ) {
    throw new InkIntentTurnError();
  }
  const result = { report, renamed };
  if (context.invocationToken)
    publishExternalInkReport(
      context.canvasId,
      context.threadId,
      context.invocationToken,
      result,
    );
  return result;
}

export async function handleReportInkIntent(
  args: ReportInkIntentArgs,
  context?: { canvasId?: string; threadId?: string },
  authorizeSpaceMutation?: () => Promise<void>,
): Promise<string> {
  if (
    !context?.canvasId ||
    !context.threadId ||
    !isActiveInkIntentTurn(context.canvasId, context.threadId)
  ) {
    throw new Error('report_ink_intent is available only during an Ink turn');
  }
  const { report, renamed } = await reportInkIntent(
    args,
    {
      canvasId: context.canvasId,
      threadId: context.threadId,
    },
    authorizeSpaceMutation,
  );
  return JSON.stringify({ ...report, renamed });
}
