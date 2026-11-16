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
 * Question its thread id, and the Note of `INITIALIZE_PDF_NOTE` its id), so the server creates the entities this page
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
    if (command.type === 'INITIALIZE_PDF_NOTE') {
      // The Note a PDF is given: this page shows it at once, so the server
      // must create the same node.
      if (command.noteId) return command;
      changed = true;
      return { ...command, noteId: createId('node') };
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
 * A data patch as JSON can carry it. A key the patch clears with
 * `undefined` — which serialization would drop — is named in `unset`
 * instead. A Question ignores `undefined` (see `MERGE_NODE_DATA`), so there
 * the key is only left out.
 */
function serializablePatch<
  T extends { patch: Record<string, unknown>; unset?: string[] },
>(entry: T, ignoresUndefined: boolean): T {
  const patch: Record<string, unknown> = {};
  const unset: string[] = [...(entry.unset ?? [])];
  let changed = false;
  for (const [key, value] of Object.entries(entry.patch)) {
    if (value === undefined) {
      changed = true;
      if (!ignoresUndefined) unset.push(key);
      continue;
    }
    if (key === 'style' && typeof value === 'object' && value !== null) {
      const style: Record<string, unknown> = {};
      for (const [leaf, leafValue] of Object.entries(value)) {
        if (leafValue === undefined) {
          changed = true;
          unset.push(`style.${leaf}`);
        } else {
          style[leaf] = leafValue;
        }
      }
      patch[key] = style;
      continue;
    }
    patch[key] = value;
  }
  if (!changed) return entry;
  const { unset: _previous, ...rest } = entry;
  void _previous;
  return {
    ...rest,
    patch,
    ...(unset.length > 0 ? { unset } : {}),
  } as T;
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
 * - A data key cleared with `undefined` is sent as an explicit `unset`.
 *
 * @param isQuestion Whether a node is a Question, whose patches ignore
 *   `undefined` rather than clearing with it.
 */
export function commandsForServer(
  commands: readonly CanvasCommand[],
  contentKeys: ReadonlySet<string>,
  isQuestion: (nodeId: string) => boolean = () => false,
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
        const unset = entry.unset?.filter((key) => !contentKeys.has(key));
        const kept = Object.fromEntries(
          keys
            .filter((key) => !contentKeys.has(key))
            .map((key) => [key, patch[key]]),
        );
        if (Object.keys(kept).length === 0 && !unset?.length) return [];
        const { unset: _all, ...rest } = entry;
        void _all;
        return [
          serializablePatch(
            {
              ...rest,
              patch: kept,
              ...(unset?.length ? { unset } : {}),
            } as typeof entry,
            isQuestion(entry.nodeId),
          ),
        ];
      });
      sent = patches.length > 0 ? { ...command, patches } : null;
    }
    if (!sent) return;
    out.push(sent);
    sourceIndex.push(index);
  });
  return { commands: out, sourceIndex };
}
