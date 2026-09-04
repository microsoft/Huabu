// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { classifySpaceInstructionFrame } from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { buildAgentNodeRef } from './node-ref.js';
import { renderPromptFile } from '../../prompt/agents/loader.js';
import { buildSpatialBundle } from '../canvas/canvas-spatial.js';
import { space } from '../storage/index.js';

import type { CanvasFile, NodeContent } from '../storage/index.js';
import type { SpaceInstructionFrameKind } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

export const SPACE_PROMPT_MAX_BYTES = 16 * 1024;
export const SPACE_SKILL_MAX_BYTES = 16 * 1024;

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

export type RenderedSpaceSkill = RenderedSpacePrompt;

interface InstructionFrameConfig {
  readonly kind: SpaceInstructionFrameKind;
  readonly template: string;
  readonly byteLimit: number;
  readonly displayName: 'Space Prompt' | 'Space Skill';
  readonly placeholder: string;
}

const INSTRUCTION_FRAME_CONFIG: Record<
  SpaceInstructionFrameKind,
  InstructionFrameConfig
> = {
  prompt: {
    kind: 'prompt',
    template: 'space-prompt.md',
    byteLimit: SPACE_PROMPT_MAX_BYTES,
    displayName: 'Space Prompt',
    placeholder: '{{SPACE_PROMPT_CONTENT}}',
  },
  skill: {
    kind: 'skill',
    template: 'space-skill.md',
    byteLimit: SPACE_SKILL_MAX_BYTES,
    displayName: 'Space Skill',
    placeholder: '{{SPACE_SKILL_CONTENT}}',
  },
};

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

function neutralizeInstructionTags(value: string): string {
  return value.replace(
    /<\/?space_(?:prompt|skill)>/gi,
    (tag) => `&lt;${tag.slice(1)}`,
  );
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
  config: InstructionFrameConfig,
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
  const complete = renderPromptFile(config.template, {
    content,
    diagnostics: omissionDiagnostics,
  });
  if (Buffer.byteLength(complete, 'utf8') <= config.byteLimit) {
    return {
      markdown: complete,
      diagnostics: { ...diagnostics, truncated: false },
    };
  }

  const marker = `\n\n[${config.displayName} truncated at the 16 KiB module limit.]`;
  const truncatedDiagnostics = [
    omissionDiagnostics,
    `- Some ${config.displayName} Frame content was truncated.`,
  ]
    .filter(Boolean)
    .join('\n');
  const shell = renderPromptFile(config.template, {
    content: config.placeholder,
    diagnostics: truncatedDiagnostics,
  });
  const available =
    config.byteLimit -
    Buffer.byteLength(shell.replace(config.placeholder, '') + marker);
  const boundedContent = truncateUtf8(content, Math.max(0, available));
  return {
    markdown: shell.replace(
      config.placeholder,
      () => `${boundedContent}${marker}`,
    ),
    diagnostics: { ...diagnostics, truncated: true },
  };
}

function renderSpaceInstructionFrames(
  canvas: CanvasFile,
  records: ReadonlyMap<string, { readonly record: NodeContent }>,
  kind: SpaceInstructionFrameKind,
): RenderedSpacePrompt | null {
  const config = INSTRUCTION_FRAME_CONFIG[kind];
  const bundle = buildSpatialBundle(canvas);
  const frames = bundle.spatialNodes
    .filter((node) => {
      const raw = bundle.rawById.get(node.id);
      const record = records.get(node.id)?.record;
      return (
        raw?.type === 'frame' &&
        classifySpaceInstructionFrame(record?.label, record?.labelSource) ===
          kind
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
        entries.push(neutralizeInstructionTags(record.content));
      } else {
        entries.push(renderNoteReference(child.raw, record));
      }
      includedNodeIds.push(child.raw.id);
    }

    if (entries.length > 0) {
      sections.push(
        `## ${neutralizeInstructionTags(recordLabel(frameRecord)) || config.displayName}\n\n${entries.join('\n\n')}`,
      );
    }
  }

  if (sections.length === 0) return null;

  return renderWithinBudget(
    sections.join('\n\n'),
    {
      includedFrameIds: frames.map((frame) => frame.raw.id),
      includedNodeIds,
      omittedUnsupportedIds,
      omittedEmptyTextIds,
      omittedMissingIds,
    },
    config,
  );
}

export function renderSpacePrompt(
  canvas: CanvasFile,
  records: ReadonlyMap<string, { readonly record: NodeContent }>,
): RenderedSpacePrompt | null {
  return renderSpaceInstructionFrames(canvas, records, 'prompt');
}

export function renderSpaceSkill(
  canvas: CanvasFile,
  records: ReadonlyMap<string, { readonly record: NodeContent }>,
): RenderedSpaceSkill | null {
  return renderSpaceInstructionFrames(canvas, records, 'skill');
}

async function resolveSpaceInstructionFrames(
  canvasId: string,
  kind: SpaceInstructionFrameKind,
): Promise<RenderedSpacePrompt | null> {
  const handle = space(canvasId);
  const canvas = await handle.read();
  if (!canvas) {
    throw new Error(`[space-${kind}] Space not found: ${canvasId}`);
  }
  const rawNodes = (canvas.state.nodes ?? []) as CanvasNode[];
  const frameIds = rawNodes
    .filter((node) => node.type === 'frame')
    .map((node) => node.id);
  if (frameIds.length === 0) return null;

  const frameRecords = await handle.nodes.readMany(frameIds);
  const matchingFrameIds = new Set(
    frameIds.filter((frameId) => {
      const record = frameRecords.get(frameId)?.record;
      return (
        classifySpaceInstructionFrame(record?.label, record?.labelSource) ===
        kind
      );
    }),
  );
  if (matchingFrameIds.size === 0) return null;

  const childIds = rawNodes
    .filter(
      (node) =>
        typeof node.parentId === 'string' &&
        matchingFrameIds.has(node.parentId) &&
        (node.type === 'text' || node.type === 'note'),
    )
    .map((node) => node.id);
  const childRecords = await handle.nodes.readMany(childIds);
  const records = new Map([...frameRecords, ...childRecords]);
  return renderSpaceInstructionFrames(canvas as CanvasFile, records, kind);
}

export function resolveSpacePrompt(
  canvasId: string,
): Promise<RenderedSpacePrompt | null> {
  return resolveSpaceInstructionFrames(canvasId, 'prompt');
}

export function resolveSpaceSkill(
  canvasId: string,
): Promise<RenderedSpaceSkill | null> {
  return resolveSpaceInstructionFrames(canvasId, 'skill');
}
