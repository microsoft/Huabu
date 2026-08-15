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

export const taskRunStatusSchema = z.enum(['pending', 'running', 'completed']);
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;

export const taskRunCompletionSchema = z
  .object({
    completedAt: z.number().int().nonnegative(),
    message: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();
export type TaskRunCompletion = z.infer<typeof taskRunCompletionSchema>;

export const taskRunRecordSchema = z
  .object({
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
    completion: taskRunCompletionSchema.optional(),
  })
  .superRefine((run, context) => {
    if (run.status === 'completed' && !run.completion) {
      context.addIssue({
        code: 'custom',
        path: ['completion'],
        message: 'completed Runs require completion metadata',
      });
    }
    if (run.status !== 'completed' && run.completion) {
      context.addIssue({
        code: 'custom',
        path: ['completion'],
        message: 'only completed Runs may carry completion metadata',
      });
    }
  });
export type TaskRunRecord = z.infer<typeof taskRunRecordSchema>;

export const taskStoreSnapshotSchema = z.object({
  version: z.literal(1),
  tasks: z.array(taskRecordSchema),
  runs: z.array(taskRunRecordSchema),
});
export type TaskStoreSnapshot = z.infer<typeof taskStoreSnapshotSchema>;

export const createTaskRequestSchema = z.object({
  goal: z
    .string()
    .trim()
    .min(1)
    .describe('The durable goal stored on the Task and its static Task Note.'),
  defaultRootProfileId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Exact id of the selectable external Agent Profile used by default for new Runs.',
    ),
  position: pointSchema.describe(
    'Top-left root-level Canvas position for the static Task Note.',
  ),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const createTaskResponseSchema = z.object({
  task: taskRecordSchema,
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

export const startTaskRunRequestSchema = z.object({
  rootProfileId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Optional exact selectable external Agent Profile id for this Run; omit to use the Task default.',
    ),
  workingDirPath: z
    .string()
    .optional()
    .describe(
      'Optional absolute working directory for the new root Agent thread.',
    ),
  additionalInitialPreamble: z
    .string()
    .optional()
    .describe(
      'Optional non-empty durable instructions appended to the root Agent initial preamble.',
    ),
});
export type StartTaskRunRequest = z.infer<typeof startTaskRunRequestSchema>;

export const startTaskRunToolParamsSchema = startTaskRunRequestSchema.extend({
  taskId: z.string().trim().min(1).describe('Task id returned by create_task.'),
});
export type StartTaskRunToolParams = z.infer<
  typeof startTaskRunToolParamsSchema
>;

export const startTaskRunResponseSchema = z.object({
  run: taskRunRecordSchema,
});
export type StartTaskRunResponse = z.infer<typeof startTaskRunResponseSchema>;

export const completeTaskRunRequestSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .optional()
      .describe(
        'Optional immutable caller-authored completion message. The platform stores it as untrusted text without interpreting issue, pull-request, or URL semantics.',
      ),
  })
  .strict();
export type CompleteTaskRunRequest = z.infer<
  typeof completeTaskRunRequestSchema
>;

export const completeTaskRunToolParamsSchema =
  completeTaskRunRequestSchema.extend({
    taskId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  });
export type CompleteTaskRunToolParams = z.infer<
  typeof completeTaskRunToolParamsSchema
>;

export const completeTaskRunResponseSchema = z.object({
  run: taskRunRecordSchema,
});
export type CompleteTaskRunResponse = z.infer<
  typeof completeTaskRunResponseSchema
>;
