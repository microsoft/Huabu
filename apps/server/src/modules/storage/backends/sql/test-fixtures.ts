// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { TaskRecord, TaskRunRecord } from '@huabu/shared';
export const note = (nodeId = 'node'): NodeContent => ({
  nodeId,
  type: 'note',
  label: nodeId,
  content: 'body',
});
export const spaceRecord = (): CanvasFile => ({
  canvasId: 'space',
  title: 'Title',
  version: 0,
  state: { nodes: [], edges: [] },
  createdAt: 1,
  updatedAt: 1,
});
export const spaceRow = () => ({
  canvas_id: 'space',
  workspace_id: 'workspace',
  title: 'Title',
  collision_key: 'title',
  version: 0,
  state_json: '{"nodes":[],"edges":[]}',
  created_at: 1,
  updated_at: 1,
  is_world: 0,
});
export const nodeRow = (id = 'node') => ({
  node_id: id,
  record_json: JSON.stringify(note(id)),
  revision: 'revision',
  label_collision_key: id,
});
export const task = (taskId = 'task'): TaskRecord => ({
  taskId,
  canvasId: 'space',
  goal: 'Goal',
  defaultRootProfileId: 'profile',
  anchorNodeId: 'anchor',
  createdAt: 1,
});
export const run = (runId = 'run'): TaskRunRecord => ({
  runId,
  taskId: 'task',
  canvasIdSnapshot: 'space',
  goalSnapshot: 'Goal',
  rootProfileIdSnapshot: 'profile',
  status: 'pending',
  createdAt: 2,
});
export const event = (id = 'node', ts = 1) => ({
  ts,
  payload: {
    action: 'node_selected' as const,
    node: { id, type: 'note' as const, label: id },
  },
});
