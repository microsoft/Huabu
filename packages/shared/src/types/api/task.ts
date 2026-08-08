// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const taskRecordSchema = z.object({
  taskId: z.string().min(1),
  canvasId: z.string().min(1),
  goal: z.string().min(1),
  defaultRootProfileId: z.string().min(1),
  anchorNodeId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const taskRunStatusSchema = z.enum(['pending', 'running']);
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;

export const taskRunRecordSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  canvasIdSnapshot: z.string().min(1),
  goalSnapshot: z.string().min(1),
  rootProfileIdSnapshot: z.string().min(1),
  status: taskRunStatusSchema,
  rootNodeId: z.string().min(1).optional(),
  rootThreadId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
});
export type TaskRunRecord = z.infer<typeof taskRunRecordSchema>;

export const taskStoreSnapshotSchema = z.object({
  version: z.literal(1),
  tasks: z.array(taskRecordSchema),
  runs: z.array(taskRunRecordSchema),
});
export type TaskStoreSnapshot = z.infer<typeof taskStoreSnapshotSchema>;

export const createTaskRequestSchema = z.object({
  goal: z.string().trim().min(1),
  defaultRootProfileId: z.string().trim().min(1),
  position: pointSchema,
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const createTaskResponseSchema = z.object({
  task: taskRecordSchema,
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

export const startTaskRunRequestSchema = z.object({
  rootProfileId: z.string().trim().min(1).optional(),
  workingDirPath: z.string().optional(),
  additionalInitialPreamble: z.string().optional(),
});
export type StartTaskRunRequest = z.infer<typeof startTaskRunRequestSchema>;

export const startTaskRunResponseSchema = z.object({
  run: taskRunRecordSchema,
});
export type StartTaskRunResponse = z.infer<typeof startTaskRunResponseSchema>;
