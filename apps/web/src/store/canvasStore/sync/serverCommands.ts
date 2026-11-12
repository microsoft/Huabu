// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shaping a `ui` command batch for the server.
 *
 * The same commands run on this page first and on the server second, so two
 * things must hold: both runs create the same ids, and the server receives
 * only what the send queue is responsible for persisting.
 *
 * Pure functions only.
 */

import { createId } from '@huabu/shared';

import type { CanvasCommand } from '@huabu/shared';

/**
 * Give every node and edge a batch creates an explicit id (and every new
 * Question its thread id), so the server creates the entities this page
 * already shows instead of minting its own.
 */
export function withClientIds(commands: CanvasCommand[]): CanvasCommand[] {
  let changed = false;
  const out = commands.map((command): CanvasCommand => {
    if (command.type === 'CREATE_NODES') {
      let touched = false;
      const nodes = command.nodes.map((node) => {
        const data = node.data as Record<string, unknown> | undefined;
        const needsThread =
          node.nodeType === 'question' &&
          !(typeof data?.threadId === 'string' && data.threadId);
        if (node.id && !needsThread) return node;
        touched = true;
        return {
          ...node,
          id: node.id ?? createId('node'),
          ...(needsThread
            ? { data: { ...data, threadId: createId('thread') } }
            : {}),
        } as typeof node;
      });
      if (!touched) return command;
      changed = true;
      return { ...command, nodes };
    }
    if (command.type === 'CONNECT_NODES') {
      if (command.edges.every((edge) => edge.id)) return command;
      changed = true;
      return {
        ...command,
        edges: command.edges.map((edge) =>
          edge.id ? edge : { ...edge, id: createId('edge') },
        ),
      };
    }
    return command;
  });
  return changed ? out : commands;
}

export interface ServerCommands {
  commands: CanvasCommand[];
  /** For each sent command, its index in the local batch. */
  sourceIndex: number[];
}

/**
 * The part of a local batch the send queue persists.
 *
 * - Selection is this page's own view state and is not sent; a created node
 *   is not selected on the server either.
 * - Content fields of existing nodes (`contentKeys`: body, label, …) keep
 *   their own writer, the per-node content PUT, with its revision check. A
 *   patch that only carries those is dropped; a mixed patch is sent without
 *   them. A created node is sent whole: the server writes its first content.
 */
export function commandsForServer(
  commands: readonly CanvasCommand[],
  contentKeys: ReadonlySet<string>,
): ServerCommands {
  const out: CanvasCommand[] = [];
  const sourceIndex: number[] = [];
  commands.forEach((command, index) => {
    let sent: CanvasCommand | null = command;
    if (command.type === 'SET_NODE_SELECTION') {
      sent = null;
    } else if (command.type === 'CREATE_NODES') {
      sent = {
        ...command,
        nodes: command.nodes.map((node) => ({
          ...node,
          selectOnCreate: false,
        })),
      };
    } else if (command.type === 'MERGE_NODE_DATA') {
      const patches = command.patches.flatMap((entry) => {
        const patch = entry.patch as Record<string, unknown>;
        const keys = Object.keys(patch);
        if (!keys.some((key) => contentKeys.has(key))) return [entry];
        const kept = Object.fromEntries(
          keys
            .filter((key) => !contentKeys.has(key))
            .map((key) => [key, patch[key]]),
        );
        return Object.keys(kept).length > 0
          ? [{ ...entry, patch: kept } as typeof entry]
          : [];
      });
      sent = patches.length > 0 ? { ...command, patches } : null;
    }
    if (!sent) return;
    out.push(sent);
    sourceIndex.push(index);
  });
  return { commands: out, sourceIndex };
}
