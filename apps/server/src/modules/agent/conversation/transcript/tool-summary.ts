// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { AssistantToolPart, ToolDetail } from '@huabu/shared';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep header inputs, never result bodies, in a historical tool summary. */
export function summarizeToolPart(
  part: AssistantToolPart,
  turnRef: string,
): AssistantToolPart {
  if (
    part.variant === 'space_commands' ||
    (part.variant === 'generic' && part.title === 'task_complete')
  ) {
    return part;
  }
  const {
    command: _command,
    content: _content,
    locations: _locations,
    rawOutput: _output,
    ...header
  } = part;
  const summary: Extract<ToolDetail, { state: 'deferred' }>['summary'] = {};
  const detail = { state: 'deferred' as const, turnRef, summary };
  if (part.variant === 'generic') {
    summary.changedPaths = [
      ...new Set(
        part.status === 'completed' && part.toolKind === 'edit'
          ? (part.content ?? []).flatMap((entry) =>
              entry.type === 'diff' &&
              entry.path.trim() &&
              entry.oldText !== entry.newText
                ? [entry.path]
                : [],
            )
          : [],
      ),
    ];
    const hasBody = Boolean(
      part.command || part.content?.length || part.locations?.length,
    );
    return { ...header, variant: 'generic', ...(hasBody ? { detail } : {}) };
  }
  const response = part.data;
  const data = object(
    response?.status === 'success' ? response.data : undefined,
  );
  const error =
    response?.status === 'error'
      ? { ...response, error: '', hint: undefined }
      : undefined;
  switch (part.variant) {
    case 'agent_tool': {
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      summary.count = nodes.length;
      summary.detailCount =
        part.toolName === 'inspect_nodes'
          ? nodes.length +
            (response?.status === 'error' || part.status === 'failed' ? 1 : 0)
          : 1;
      summary.changedPaths =
        part.toolName === 'fs_write' &&
        response?.status === 'success' &&
        (part.status === 'completed' || part.status === undefined) &&
        data.ok === true &&
        typeof data.target === 'string' &&
        data.target.trim()
          ? [data.target]
          : [];
      const compact: Record<string, unknown> = {};
      for (const key of ['path', 'pattern', 'count']) {
        if (typeof data[key] === 'string' || typeof data[key] === 'number')
          compact[key] = data[key];
      }
      if (
        part.toolName === 'read' &&
        typeof data.path !== 'string' &&
        typeof data.content === 'string'
      ) {
        compact.content = data.content;
      }
      const frontmatter = object(data.frontmatter);
      compact.frontmatter = { id: frontmatter.id, label: frontmatter.label };
      compact.nodes =
        nodes.length === 1
          ? nodes.map((node) => {
              const value = object(node);
              return { id: value.id, label: value.label };
            })
          : [];
      return {
        ...header,
        variant: 'agent_tool',
        toolName: part.toolName,
        detail,
        data:
          response?.status === 'error'
            ? { tool: part.toolName, status: 'error', error: response.error }
            : response
              ? { tool: part.toolName, status: 'success', data: compact }
              : undefined,
      };
    }
    case 'web_search':
      summary.count =
        response?.status === 'success'
          ? part.data?.status === 'success'
            ? part.data.data.results.filter(
                (r) => typeof r.url === 'string' && r.url.trim(),
              ).length
            : 0
          : 0;
      return {
        ...header,
        variant: 'web_search',
        ...(summary.count > 0 ? { detail } : {}),
        data: error
          ? { tool: 'web_search', status: 'error', error: '' }
          : response
            ? {
                tool: 'web_search',
                status: 'success',
                data: { query: '', results: [] },
              }
            : undefined,
      };
    case 'snapshot_nodes':
      summary.nodeCount = Array.isArray(data.nodeIds) ? data.nodeIds.length : 0;
      summary.imageCount = Array.isArray(data.snapshots)
        ? data.snapshots.length
        : 0;
      return {
        ...header,
        variant: 'snapshot_nodes',
        ...(summary.imageCount > 0 || error || part.status === 'failed'
          ? { detail }
          : {}),
        data: error
          ? { tool: 'snapshot_nodes', status: 'error', error: '' }
          : response
            ? { tool: 'snapshot_nodes', status: 'success', data: {} }
            : undefined,
      };
    case 'image_generation':
      summary.referenceCount = Array.isArray(data.referenceArtifactSrcs)
        ? data.referenceArtifactSrcs.length
        : 0;
      return {
        ...header,
        variant: 'image_generation',
        detail,
        data: error
          ? { tool: 'generate_image', status: 'error', error: '' }
          : response
            ? {
                tool: 'generate_image',
                status: 'success',
                data: {
                  prompt:
                    typeof data.prompt === 'string'
                      ? data.prompt.length > 60
                        ? `${data.prompt.slice(0, 60)}…`
                        : data.prompt
                      : undefined,
                },
              }
            : undefined,
      };
  }
}
