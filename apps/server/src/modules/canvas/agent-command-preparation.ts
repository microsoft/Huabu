// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';

import type {
  AgentOperationCommand,
  CanvasCommand,
  NodeOrigin,
} from '@huabu/shared';

export interface PrepareAgentCommandsOptions {
  origin?: NodeOrigin;
  readSet?: ReadonlyMap<string, string>;
  allowCallerRevisions?: boolean;
}

const DEFAULT_ORIGIN: NodeOrigin = { type: 'ai-operate' };

function normalizeAgentAuthoredContent(
  content: unknown,
  nodeId: string,
): unknown {
  if (typeof content !== 'string' || !content.startsWith('---')) {
    return content;
  }

  const parsed = parseFrontmatter(content);
  return parsed.meta['id'] === nodeId ? parsed.content : content;
}

/**
 * Add server-owned authorship metadata and optional built-in-agent read-set
 * revisions before canonical execution.
 */
export function prepareAgentCanvasCommands(
  commands: readonly AgentOperationCommand[],
  options: PrepareAgentCommandsOptions = {},
): CanvasCommand[] {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const annotated = commands.map((command) => {
    if (command.type === 'CREATE_NODES') {
      return {
        ...command,
        nodes: command.nodes.map((node) => {
          const data = node.data ?? {};
          return {
            ...node,
            data: {
              ...data,
              origin,
              ...(typeof data.label === 'string'
                ? { labelSource: 'agent' as const }
                : {}),
            },
          };
        }),
      };
    }

    if (command.type === 'MERGE_NODE_DATA') {
      return {
        ...command,
        patches: command.patches.map((entry) => {
          const { expectRev: callerRevision, ...patchEntry } = entry;
          const hasLabel = typeof entry.patch.label === 'string';
          const content = normalizeAgentAuthoredContent(
            entry.patch.content,
            entry.nodeId,
          );
          const injectedRev =
            'content' in entry.patch && options.readSet
              ? options.readSet.get(entry.nodeId)
              : undefined;
          const revision =
            injectedRev ??
            (options.allowCallerRevisions ? callerRevision : undefined);
          return {
            ...patchEntry,
            patch: {
              ...entry.patch,
              ...('content' in entry.patch ? { content } : {}),
              ...(hasLabel ? { labelSource: 'agent' as const } : {}),
            },
            ...(revision !== undefined ? { expectRev: revision } : {}),
          };
        }),
      };
    }

    if (command.type === 'CONNECT_NODES') {
      return {
        ...command,
        edges: command.edges.map((edge) => ({
          ...edge,
          ...(edge.style
            ? {
                style: {
                  ...edge.style,
                  ...(typeof edge.style.label === 'string' &&
                  edge.style.label.length > 0
                    ? { labelSource: 'agent' as const }
                    : {}),
                },
              }
            : {}),
        })),
      };
    }

    if (command.type === 'SET_EDGE_STYLE') {
      return {
        ...command,
        edges: command.edges.map((entry) => ({
          ...entry,
          style: {
            ...entry.style,
            ...(typeof entry.style.label === 'string' &&
            entry.style.label.length > 0
              ? { labelSource: 'agent' as const }
              : {}),
          },
        })),
      };
    }

    return command;
  });

  // Zod validates plain wire strings; CanvasCommand brands node/edge IDs at
  // compile time and accepts the additional server-owned metadata above.
  return annotated as unknown as CanvasCommand[];
}
