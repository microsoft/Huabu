// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isPromptFrame } from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { buildAgentNodeRef } from './node-ref.js';
import { renderPromptFile } from '../../prompt/agents/loader.js';
import { buildSpatialBundle } from '../canvas/canvas-spatial.js';
import { space } from '../storage/index.js';

import type { CanvasFile, NodeContent } from '../storage/index.js';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

export const SPACE_PROMPT_MAX_BYTES = 16 * 1024;

export interface SpacePromptDiagnostics {
  readonly includedFrameIds: readonly string[];
  readonly includedNodeIds: readonly string[];
  readonly omittedUnsupportedIds: readonly string[];
  readonly omittedEmptyTextIds: readonly string[];
  readonly omittedMissingIds: readonly string[];
  readonly truncated: boolean;
}

export interface RenderedSpacePrompt {
  readonly markdown: string;
  readonly diagnostics: SpacePromptDiagnostics;
}

interface OrderedNode {
  readonly raw: CanvasNode;
  readonly x: number;
  readonly y: number;
}

function compareReadingOrder(a: OrderedNode, b: OrderedNode): number {
  return (
    a.y - b.y ||
    a.x - b.x ||
    (a.raw.id < b.raw.id ? -1 : a.raw.id > b.raw.id ? 1 : 0)
  );
}

function recordLabel(record: NodeContent): string {
  return typeof record.label === 'string' ? record.label : '';
}

function quoteAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function neutralizeSpacePromptTags(value: string): string {
  return value.replace(/<\/?space_prompt>/gi, (tag) => `&lt;${tag.slice(1)}`);
}

function renderNoteReference(node: CanvasNode, record: NodeContent): string {
  const ref = buildAgentNodeRef({
    id: node.id,
    type: 'note',
    label: recordLabel(record),
  });
  const rev = nodeRevisionOf({
    content: record.content,
    ...(typeof record.src === 'string' ? { src: record.src } : {}),
  });
  return `<note id="${quoteAttribute(ref.id)}" label="${quoteAttribute(
    ref.label ?? '',
  )}" file="${quoteAttribute(ref.filename)}" rev="${quoteAttribute(rev)}" />`;
}

function truncateUtf8(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= byteLimit) return value;
  let used = 0;
  let output = '';
  for (const char of value) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (used + bytes > byteLimit) break;
    output += char;
    used += bytes;
  }
  return output;
}

function renderWithinBudget(
  content: string,
  diagnostics: Omit<SpacePromptDiagnostics, 'truncated'>,
): RenderedSpacePrompt {
  const omissionDiagnostics = [
    diagnostics.omittedUnsupportedIds.length > 0
      ? `- Omitted unsupported direct children: ${diagnostics.omittedUnsupportedIds.length}.`
      : '',
    diagnostics.omittedEmptyTextIds.length > 0
      ? `- Omitted empty Text nodes: ${diagnostics.omittedEmptyTextIds.length}.`
      : '',
    diagnostics.omittedMissingIds.length > 0
      ? `- Omitted missing node records: ${diagnostics.omittedMissingIds.length}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const complete = renderPromptFile('space-prompt.md', {
    content,
    diagnostics: omissionDiagnostics,
  });
  if (Buffer.byteLength(complete, 'utf8') <= SPACE_PROMPT_MAX_BYTES) {
    return {
      markdown: complete,
      diagnostics: { ...diagnostics, truncated: false },
    };
  }

  const marker = '\n\n[Space Prompt truncated at the 16 KiB injection limit.]';
  const truncatedDiagnostics = [
    omissionDiagnostics,
    '- Some Prompt Frame content was truncated.',
  ]
    .filter(Boolean)
    .join('\n');
  const shell = renderPromptFile('space-prompt.md', {
    content: '{{SPACE_PROMPT_CONTENT}}',
    diagnostics: truncatedDiagnostics,
  });
  const available =
    SPACE_PROMPT_MAX_BYTES -
    Buffer.byteLength(shell.replace('{{SPACE_PROMPT_CONTENT}}', '') + marker);
  const boundedContent = truncateUtf8(content, Math.max(0, available));
  return {
    markdown: shell.replace(
      '{{SPACE_PROMPT_CONTENT}}',
      () => `${boundedContent}${marker}`,
    ),
    diagnostics: { ...diagnostics, truncated: true },
  };
}

export function renderSpacePrompt(
  canvas: CanvasFile,
  records: ReadonlyMap<string, { readonly record: NodeContent }>,
): RenderedSpacePrompt | null {
  const bundle = buildSpatialBundle(canvas);
  const frames = bundle.spatialNodes
    .filter((node) => {
      const raw = bundle.rawById.get(node.id);
      const record = records.get(node.id)?.record;
      return (
        raw?.type === 'frame' &&
        isPromptFrame(record?.label, record?.labelSource)
      );
    })
    .flatMap((node) => {
      const raw = bundle.rawById.get(node.id);
      return raw ? [{ raw, x: node.rect.x, y: node.rect.y }] : [];
    })
    .sort(compareReadingOrder);

  if (frames.length === 0) return null;

  const includedNodeIds: string[] = [];
  const omittedUnsupportedIds: string[] = [];
  const omittedEmptyTextIds: string[] = [];
  const omittedMissingIds: string[] = [];
  const sections: string[] = [];

  for (const frame of frames) {
    const frameRecord = records.get(frame.raw.id)?.record;
    if (!frameRecord) continue;
    const children = [...bundle.rawById.values()]
      .filter((node) => node.parentId === frame.raw.id)
      .map((raw) => ({
        raw,
        x: raw.position.x,
        y: raw.position.y,
      }))
      .sort(compareReadingOrder);
    const entries: string[] = [];

    for (const child of children) {
      if (child.raw.type !== 'text' && child.raw.type !== 'note') {
        omittedUnsupportedIds.push(child.raw.id);
        continue;
      }
      const record = records.get(child.raw.id)?.record;
      if (!record) {
        omittedMissingIds.push(child.raw.id);
        continue;
      }
      if (child.raw.type === 'text') {
        if (!record.content.trim()) {
          omittedEmptyTextIds.push(child.raw.id);
          continue;
        }
        entries.push(neutralizeSpacePromptTags(record.content));
      } else {
        entries.push(renderNoteReference(child.raw, record));
      }
      includedNodeIds.push(child.raw.id);
    }

    if (entries.length > 0) {
      sections.push(
        `## ${neutralizeSpacePromptTags(recordLabel(frameRecord)) || 'Prompt'}\n\n${entries.join('\n\n')}`,
      );
    }
  }

  if (sections.length === 0) return null;

  return renderWithinBudget(sections.join('\n\n'), {
    includedFrameIds: frames.map((frame) => frame.raw.id),
    includedNodeIds,
    omittedUnsupportedIds,
    omittedEmptyTextIds,
    omittedMissingIds,
  });
}

export async function resolveSpacePrompt(
  canvasId: string,
): Promise<RenderedSpacePrompt | null> {
  const handle = space(canvasId);
  const [canvas, records] = await Promise.all([
    handle.read(),
    handle.nodes.list(),
  ]);
  if (!canvas) {
    throw new Error(`[space-prompt] Space not found: ${canvasId}`);
  }
  return renderSpacePrompt(canvas as CanvasFile, records);
}
