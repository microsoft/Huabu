// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentInputSchema } from '@agenetes/protocol';

import { fingerprintNodeFields } from '@huabu/shared/canvas-engine';

import {
  escapeXmlAttr,
  escapeXmlText,
} from '../agent/conversation/prompt/node-element.js';

import type { AgentInputPart } from '@agenetes/protocol';
import type {
  CanvasCommand,
  ChatAttachment,
  ChatEnvelope,
  InkResourceReference,
  RecentAction,
  VisibleCanvasGrounding,
} from '@huabu/shared';

type RecordValue = Record<string, unknown>;
type Rewrite = (value: unknown, context?: string) => unknown;
type Shape<T> = Record<keyof T, string | null>;

const envelopeFields = {
  requestId: null,
  user: 'chat-user',
  skills: null,
  focus: 'chat-focus',
} satisfies Shape<ChatEnvelope>;
const userFields = {
  text: null,
  quotedComments: null,
  inputKind: null,
  attachments: 'attachments',
} satisfies Shape<ChatEnvelope['user']>;
const focusFields = {
  anchor: 'anchor',
  selection: 'chat-selection',
  resources: 'chat-resources',
  groundingVisual: 'grounding',
} satisfies Shape<ChatEnvelope['focus']>;
const selectionFields = {
  refs: 'refs',
  selectedIds: 'nodeIds',
  strokeSubsets: 'geometry',
  inkGeometry: 'geometry',
  inkRecognition: 'inkRecognition',
  imageAttachments: 'attachments',
  snapshotAttachments: 'attachments',
  textContents: 'text-contents',
} satisfies Shape<ChatEnvelope['focus']['selection']>;
const textContentFields = {
  nodeId: 'nodeId',
  content: null,
} satisfies Shape<
  NonNullable<ChatEnvelope['focus']['selection']['textContents']>[number]
>;
const resourceFields = {
  bindings: 'resource-reference',
  refs: 'refs',
  imageAttachments: 'attachments',
} satisfies Shape<NonNullable<ChatEnvelope['focus']['resources']>>;
const resourceReferenceFields = {
  id: null,
  fingerprint: null,
  targetNodeId: 'nodeId',
  targetType: null,
  label: null,
  sources: 'geometry',
  sourceBounds: null,
} satisfies Shape<InkResourceReference>;
const groundingFields = {
  kind: null,
  dataUrl: null,
  viewport: null,
  crop: null,
  selectedNodeIds: 'nodeIds',
  strokeSubsets: 'geometry',
} satisfies Shape<VisibleCanvasGrounding>;
const attachmentFields = {
  type: null,
  source: null,
  content: 'link',
  label: null,
  filename: null,
  originNodeId: 'nodeId',
  originNodeIds: 'nodeIds',
  url: 'link',
} satisfies Shape<ChatAttachment>;

function isImportRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Adding a command/action or field requires an explicit identity-versus-opaque decision.
const commandFields = {
  CREATE_NODES: { nodes: 'nodes' },
  DELETE_NODES: { nodeIds: 'nodeIds' },
  MERGE_NODE_DATA: { patches: 'patches' },
  SET_NODE_PARENT: { nodeIds: 'nodeIds', parentId: 'nodeId' },
  DISSOLVE_FRAME: { frameId: 'nodeId' },
  SET_NODE_GEOMETRY: { items: 'geometry' },
  REORDER_NODES: { nodeIds: 'nodeIds', to: 'order' },
  CONNECT_NODES: { edges: 'edges' },
  DISCONNECT_EDGES: { edges: 'edge-ref' },
  SET_EDGE_STYLE: { edges: 'edge-style' },
  ALIGN_NODES: { nodeIds: 'nodeIds', direction: null },
  DISTRIBUTE_NODES: { nodeIds: 'nodeIds' },
  SET_NODE_SELECTION: { nodeIds: 'nodeIds' },
  SET_NODE_LOCKED: { items: 'geometry' },
  APPLY_MEASURED_HEIGHT: { items: 'geometry' },
  SET_FRAME_LAYOUT: {
    frameId: 'nodeId',
    cells: 'geometry',
    mode: null,
    gridCount: null,
    gridRowCount: null,
    sizing: null,
  },
  CHANGE_NODE_TYPE: { nodeId: 'nodeId', to: null },
} satisfies {
  [T in CanvasCommand['type']]: Shape<
    Omit<Extract<CanvasCommand, { type: T }>, 'type'>
  >;
};

const actionFields = {
  node_created: { nodes: 'nodes' },
  nodes_deleted: { nodes: 'nodes' },
  node_edited: { node: 'node', edit: null },
  node_selected: { node: 'node' },
  nodes_selected: { nodes: 'nodes' },
  node_expanded: { node: 'node' },
  node_connected: { source: 'node', target: 'node' },
  edges_disconnected: { edges: 'action-edge' },
  node_framed: { node: 'node', frame: 'node' },
  node_unframed: { node: 'node', frame: 'node' },
  frame_unframed: { frame: 'node', nodes: 'nodes' },
  node_resized: { node: 'node', width: null, height: null },
  nodes_reordered: { nodes: 'nodes' },
  nodes_moved: { nodes: 'nodes' },
  canvas_undone: {},
  canvas_redone: {},
} satisfies {
  [T in RecentAction['action']]: Shape<
    Omit<Extract<RecentAction, { action: T }>, 'action'>
  >;
};

function fields(
  value: RecordValue,
  shape: Record<string, string | null>,
  rewrite: Rewrite,
): RecordValue {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      Object.hasOwn(shape, key) && shape[key] !== null
        ? rewrite(item, shape[key])
        : item,
    ]),
  );
}

/** Known host contracts override the legacy history walker; undefined means not handled. */
export function rewriteImportContract(
  value: RecordValue,
  context: string,
  rewrite: Rewrite,
): RecordValue | undefined {
  if (context === 'commands' && typeof value.type === 'string') {
    const shape = Object.entries(commandFields).find(
      ([type]) => type === value.type,
    )?.[1];
    if (!shape)
      throw new Error(`Unsupported imported Canvas command: ${value.type}`);
    return fields(value, shape, rewrite);
  }
  if (
    typeof value.action === 'string' &&
    (context === 'payload' || context === 'action')
  ) {
    const shape = Object.entries(actionFields).find(
      ([action]) => action === value.action,
    )?.[1];
    if (!shape)
      throw new Error(`Unsupported imported Canvas action: ${value.action}`);
    return fields(value, shape, rewrite);
  }
  switch (context) {
    case 'view-event':
      return fields(value, { nodeId: 'nodeId' }, rewrite);
    case 'geometry':
      return fields(value, { nodeId: 'nodeId' }, rewrite);
    case 'order':
      return fields(value, { before: 'nodeId', after: 'nodeId' }, rewrite);
    case 'edge-ref':
      return fields(value, { source: 'nodeId', target: 'nodeId' }, rewrite);
    case 'edge-style':
      return fields(value, { edge: 'edge-ref' }, rewrite);
    case 'action-edge':
      return fields(value, { source: 'node', target: 'node' }, rewrite);
    case 'chat-envelope':
      return fields(value, envelopeFields, rewrite);
    case 'chat-user':
      return fields(value, userFields, rewrite);
    case 'chat-focus':
      return fields(value, focusFields, rewrite);
    case 'chat-selection':
      return fields(value, selectionFields, rewrite);
    case 'text-contents':
      return fields(value, textContentFields, rewrite);
    case 'chat-resources':
      return fields(value, resourceFields, rewrite);
    case 'resource-reference':
      return fields(value, resourceReferenceFields, rewrite);
    case 'grounding':
      return fields(value, groundingFields, rewrite);
    case 'attachments':
    case 'imageAttachments':
    case 'snapshotAttachments':
      return fields(value, attachmentFields, rewrite);
    case 'origin':
      return fields(
        value,
        { threadId: 'threadId', excerptFromNodeId: 'nodeId' },
        rewrite,
      );
    default:
      return undefined;
  }
}

/** Rebase the guard from its historical applied snapshot, never from today's node. */
export function rewriteImportedChange(
  original: RecordValue,
  mapped: RecordValue,
): RecordValue {
  if (original.appliedFingerprint === undefined) return mapped;
  if (
    !Array.isArray(original.fingerprintKeys) ||
    !original.fingerprintKeys.every(
      (key): key is string => typeof key === 'string',
    )
  ) {
    throw new Error('Invalid imported change fingerprint keys');
  }
  const applied = (record: RecordValue) => {
    const delta = Array.isArray(record.revertDeltas)
      ? record.revertDeltas[0]
      : undefined;
    const node = isImportRecord(delta)
      ? delta.type === 'DELETE_NODE'
        ? delta.node
        : delta.type === 'REPLACE_NODE'
          ? delta.prev
          : undefined
      : undefined;
    if (
      !isImportRecord(node) ||
      typeof node.id !== 'string' ||
      !isImportRecord(node.data)
    )
      throw new Error('Invalid imported change applied snapshot');
    return { id: node.id, data: node.data, position: { x: 0, y: 0 } };
  };
  if (
    fingerprintNodeFields(applied(original), original.fingerprintKeys) !==
    original.appliedFingerprint
  )
    throw new Error(
      'Imported change fingerprint does not match its applied snapshot',
    );
  return {
    ...mapped,
    appliedFingerprint: fingerprintNodeFields(
      applied(mapped),
      original.fingerprintKeys,
    ),
  };
}

/** Migrate captured inputs without fetching live nodes, regenerating images, or editing user text. */
export function rewriteImportedInputs(
  rendered: unknown,
  userText: unknown,
  identities: ReadonlyMap<string, string>,
  links: (text: string) => string,
  rewrite: Rewrite,
): unknown {
  if (!Array.isArray(rendered))
    throw new Error('Invalid imported rendered inputs');
  const xmlIds = new Map(
    [...identities].map(([from, to]) => [
      escapeXmlAttr(from),
      escapeXmlAttr(to),
    ]),
  );
  const xmlReference = (value: string) => xmlIds.get(value) ?? value;
  const markup = (raw: string): string =>
    links(raw).replace(
      /<(node|edge|attachment|ink_ocr)\b[^>]*>/g,
      (tag, kind: string) =>
        tag.replace(
          /\b(id|from|to|source|target|origin)="([^"]*)"/g,
          (attribute: string, key: string, value: string) => {
            const isReference =
              kind === 'node'
                ? key === 'id'
                : kind === 'edge'
                  ? ['from', 'to', 'source', 'target'].includes(key)
                  : key === 'origin';
            if (!isReference) return attribute;
            const separator = kind === 'ink_ocr' ? ' ' : ', ';
            const mapped =
              key === 'origin'
                ? value.split(separator).map(xmlReference).join(separator)
                : xmlReference(value);
            return `${key}="${mapped}"`;
          },
        ),
    );
  const hostText = (raw: string): string => {
    const jsonSections =
      /(<(ink_query_geometry|ink_resource_references|interactive_view_event)>\n[\s\S]*?\n)([^\n]+)(\n<\/\2>)/g;
    let result = '';
    let offset = 0;
    for (const match of raw.matchAll(jsonSections)) {
      const [, prefix, kind, json, suffix] = match;
      const decoded = json
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      const mapped = rewrite(
        JSON.parse(decoded),
        kind === 'ink_query_geometry'
          ? 'geometry'
          : kind === 'interactive_view_event'
            ? 'view-event'
            : 'resource-reference',
      );
      result +=
        markup(raw.slice(offset, match.index)) +
        prefix +
        escapeXmlText(JSON.stringify(mapped)) +
        suffix;
      offset = match.index + match[0].length;
    }
    return result + markup(raw.slice(offset));
  };
  const text = (raw: string): string => {
    if (raw === userText) return raw;
    // Some adapters flatten text parts. Preserve protected sections even inside one input.
    const protectedSections =
      /<(invoked_skills|quoted_comments)>[\s\S]*?<\/\1>|<user_request>[\s\S]*<\/user_request>/g;
    let result = '';
    let offset = 0;
    for (const match of raw.matchAll(protectedSections)) {
      result += hostText(raw.slice(offset, match.index)) + match[0];
      offset = match.index + match[0].length;
    }
    return result + hostText(raw.slice(offset));
  };
  const part = (value: AgentInputPart): AgentInputPart =>
    value.type === 'text' ? { ...value, text: text(value.text) } : value;
  return rendered.map((raw) => {
    const input = agentInputSchema.parse(raw);
    switch (input.type) {
      case 'text':
        return { ...input, text: text(input.text) };
      case 'parts':
        return { ...input, parts: input.parts.map(part) };
      case 'command':
        return { ...input, context: input.context.map(part) };
    }
  });
}
