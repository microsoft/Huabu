import {
  AGENT_CANVAS_COMMAND_TYPES,
  AGENT_COMMAND_SCHEMAS,
  SPACE_EXECUTE_MAX_COMMANDS,
  SPACE_OPERATIONS_PROTOCOL_VERSION,
  SPACE_QUERY_DEFAULT_LIMIT,
  SPACE_QUERY_MAX_LIMIT,
  SPACE_QUERY_SCHEMAS,
  SPACE_QUERY_TYPES,
  SPACE_SEARCH_DEFAULT_LIMIT,
  SPACE_SEARCH_MAX_LIMIT,
} from '@sediment/shared';
import { z } from 'zod';

import type {
  RfsCapabilitiesResponse,
  RfsOperationCapabilityResponse,
} from '@sediment/shared';

const QUERY_DETAILS: Record<
  (typeof SPACE_QUERY_TYPES)[number],
  Pick<RfsOperationCapabilityResponse, 'constraints' | 'result' | 'examples'>
> = {
  GET_SPACE_OUTLINE: {
    constraints: ['Previews and visual style are opt-in.'],
    result: 'Whole-Space geometry, topology, and spatial clusters.',
    examples: [{ type: 'GET_SPACE_OUTLINE' }],
  },
  INSPECT_NODES: {
    constraints: [`At most ${SPACE_QUERY_MAX_LIMIT} results.`],
    result: 'Bounded node matches with geometry and derived spatial fields.',
    examples: [{ type: 'INSPECT_NODES', ids: ['node-123'] }],
  },
  INSPECT_EDGES: {
    constraints: [`At most ${SPACE_QUERY_MAX_LIMIT} results.`],
    result: 'Bounded edge matches with complete edge style.',
    examples: [{ type: 'INSPECT_EDGES', connectedTo: 'node-123' }],
  },
  SEARCH: {
    constraints: [
      `Literal case-insensitive search with at most ${SPACE_SEARCH_MAX_LIMIT} matches.`,
    ],
    result: 'Bounded metadata, content, and conversation matches.',
    examples: [{ type: 'SEARCH', query: 'architecture', limit: 50 }],
  },
};

const COMMAND_RESULT =
  'One entry in the ordered execution results, including generated IDs or a structured failure.';

const COMMAND_EXAMPLES: Record<
  (typeof AGENT_CANVAS_COMMAND_TYPES)[number],
  unknown
> = {
  CREATE_NODES: {
    type: 'CREATE_NODES',
    nodes: [
      {
        nodeType: 'note',
        data: { label: 'Summary', content: '# Summary' },
        position: { x: 100, y: 100 },
      },
    ],
  },
  DELETE_NODES: { type: 'DELETE_NODES', nodeIds: ['node-123'] },
  MERGE_NODE_DATA: {
    type: 'MERGE_NODE_DATA',
    patches: [
      {
        nodeId: 'node-123',
        expectRev: 'revision-from-download-etag',
        patch: { content: '# Updated content' },
      },
    ],
  },
  SET_NODE_PARENT: {
    type: 'SET_NODE_PARENT',
    nodeIds: ['node-123'],
    parentId: 'frame-456',
  },
  DISSOLVE_FRAME: { type: 'DISSOLVE_FRAME', frameId: 'frame-456' },
  SET_NODE_GEOMETRY: {
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: 'node-123', position: { x: 200, y: 100 } }],
  },
  REORDER_NODES: {
    type: 'REORDER_NODES',
    nodeIds: ['node-123'],
    to: 'top',
  },
  CONNECT_NODES: {
    type: 'CONNECT_NODES',
    edges: [{ source: 'node-123', target: 'node-456' }],
  },
  DISCONNECT_EDGES: {
    type: 'DISCONNECT_EDGES',
    edges: ['edge-123'],
  },
  SET_EDGE_STYLE: {
    type: 'SET_EDGE_STYLE',
    edges: [{ edge: 'edge-123', style: { direction: 'forward' } }],
  },
  ALIGN_NODES: {
    type: 'ALIGN_NODES',
    nodeIds: ['node-123', 'node-456'],
    direction: 'left',
  },
  DISTRIBUTE_NODES: {
    type: 'DISTRIBUTE_NODES',
    nodeIds: ['node-123', 'node-456', 'node-789'],
  },
  SET_FRAME_LAYOUT: {
    type: 'SET_FRAME_LAYOUT',
    frameId: 'frame-456',
    mode: 'column',
    gridCount: 2,
  },
};

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    reused: 'inline',
  });
  delete jsonSchema.$schema;
  return jsonSchema;
}

function hasOwnKey<T extends object>(
  value: T,
  key: PropertyKey,
): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function getRfsCapabilities(): RfsCapabilitiesResponse {
  return {
    protocolVersion: SPACE_OPERATIONS_PROTOCOL_VERSION,
    permissions: { read: true, write: true },
    execution: {
      atomic: false,
      partialCommit: true,
      idempotent: false,
      runIdIsIdempotencyKey: false,
    },
    limits: {
      queryDefault: SPACE_QUERY_DEFAULT_LIMIT,
      queryMax: SPACE_QUERY_MAX_LIMIT,
      searchDefault: SPACE_SEARCH_DEFAULT_LIMIT,
      searchMax: SPACE_SEARCH_MAX_LIMIT,
      executeMaxCommands: SPACE_EXECUTE_MAX_COMMANDS,
    },
    queryTypes: [...SPACE_QUERY_TYPES],
    commandTypes: [...AGENT_CANVAS_COMMAND_TYPES],
    links: {
      skill: 'skill',
      query: 'query',
      execute: 'execute',
      queryCapabilityTemplate: 'capabilities/queries/{type}',
      commandCapabilityTemplate: 'capabilities/commands/{type}',
    },
  };
}

export function getQueryCapability(
  type: string,
): RfsOperationCapabilityResponse | undefined {
  if (!hasOwnKey(SPACE_QUERY_SCHEMAS, type)) return undefined;
  return {
    kind: 'query',
    type,
    schema: toJsonSchema(SPACE_QUERY_SCHEMAS[type]),
    ...QUERY_DETAILS[type],
  };
}

export function getCommandCapability(
  type: string,
): RfsOperationCapabilityResponse | undefined {
  if (!hasOwnKey(AGENT_COMMAND_SCHEMAS, type)) return undefined;
  return {
    kind: 'command',
    type,
    schema: toJsonSchema(AGENT_COMMAND_SCHEMAS[type]),
    constraints: [
      `The complete execute request accepts at most ${SPACE_EXECUTE_MAX_COMMANDS} ordered commands.`,
      'The server assigns IDs for created nodes and edges.',
    ],
    result: COMMAND_RESULT,
    examples: [COMMAND_EXAMPLES[type]],
  };
}
