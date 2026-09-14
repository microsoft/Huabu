// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  taskRecordSchema,
  taskRunCompletionSchema,
  taskRunRecordSchema,
  taskStoreSnapshotSchema,
  type TaskRecord,
  type TaskRunCompletion,
  type TaskRunRecord,
  type TaskStoreSnapshot,
} from '@huabu/shared';

import type {
  SpaceTaskRuns,
  SpaceTasks,
  TaskRunCompletionResult,
  TaskRunUpdate,
} from '../../ports/structured.js';

export function validateSnapshot(
  value: unknown,
  canvasId: string,
): TaskStoreSnapshot {
  const parsed = taskStoreSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new SyntaxError(
      `Invalid Task store for Canvas ${canvasId}: ${parsed.error.issues[0]?.message ?? 'schema violation'}`,
    );
  }
  const taskIds = new Set<string>();
  for (const task of parsed.data.tasks) {
    if (task.canvasId !== canvasId) {
      throw new SyntaxError(
        `Invalid Task store for Canvas ${canvasId}: Task ${task.taskId} belongs to Canvas ${task.canvasId}`,
      );
    }
    if (taskIds.has(task.taskId)) {
      throw new SyntaxError(
        `Invalid Task store for Canvas ${canvasId}: duplicate Task ${task.taskId}`,
      );
    }
    taskIds.add(task.taskId);
  }
  const runIds = new Set<string>();
  for (const run of parsed.data.runs) {
    if (run.canvasIdSnapshot !== canvasId) {
      throw new SyntaxError(
        `Invalid Task store for Canvas ${canvasId}: Run ${run.runId} belongs to Canvas ${run.canvasIdSnapshot}`,
      );
    }
    if (runIds.has(run.runId)) {
      throw new SyntaxError(
        `Invalid Task store for Canvas ${canvasId}: duplicate Run ${run.runId}`,
      );
    }
    if (!taskIds.has(run.taskId)) {
      throw new SyntaxError(
        `Invalid Task store for Canvas ${canvasId}: Run ${run.runId} references missing Task ${run.taskId}`,
      );
    }
    runIds.add(run.runId);
  }
  return parsed.data;
}

export class SqlSpaceTasks implements SpaceTasks {
  readonly runs: SpaceTaskRuns;

  readonly #canvasId: string;

  constructor(
    private readonly readSnapshot: () =>
      | Promise<TaskStoreSnapshot>
      | TaskStoreSnapshot,
    private readonly mutateSnapshot: <T>(
      apply: (snapshot: TaskStoreSnapshot) => T,
    ) => Promise<T> | T,
    canvasId: string,
  ) {
    this.#canvasId = canvasId;
    this.runs = Object.freeze({
      create: (run: TaskRunRecord) => this.#createRun(run),
      update: (runId: string, update: TaskRunUpdate) =>
        this.#updateRun(runId, update),
      complete: (
        taskId: string,
        runId: string,
        completion: TaskRunCompletion,
      ) => this.#completeRun(taskId, runId, completion),
    });
  }

  async read(): Promise<TaskStoreSnapshot> {
    return this.readSnapshot();
  }

  async create(task: TaskRecord): Promise<void> {
    const parsed = taskRecordSchema.safeParse(task);
    if (!parsed.success || parsed.data.canvasId !== this.#canvasId) {
      throw new TypeError(`Invalid Task record for Canvas ${this.#canvasId}`);
    }
    await this.mutateSnapshot((snapshot) => {
      if (
        snapshot.tasks.some(
          (candidate) => candidate.taskId === parsed.data.taskId,
        )
      ) {
        throw new Error(`Task ${parsed.data.taskId} already exists`);
      }
      snapshot.tasks.push(parsed.data);
    });
  }

  async #createRun(run: TaskRunRecord): Promise<void> {
    const parsed = taskRunRecordSchema.safeParse(run);
    if (!parsed.success || parsed.data.canvasIdSnapshot !== this.#canvasId) {
      throw new TypeError(`Invalid Run record for Canvas ${this.#canvasId}`);
    }
    await this.mutateSnapshot((snapshot) => {
      if (
        snapshot.runs.some((candidate) => candidate.runId === parsed.data.runId)
      ) {
        throw new Error(`Run ${parsed.data.runId} already exists`);
      }
      if (
        !snapshot.tasks.some(
          (candidate) => candidate.taskId === parsed.data.taskId,
        )
      ) {
        throw new Error(`Task ${parsed.data.taskId} does not exist`);
      }
      snapshot.runs.push(parsed.data);
    });
  }

  async #updateRun(
    runId: string,
    update: TaskRunUpdate,
  ): Promise<TaskRunRecord> {
    return this.mutateSnapshot((snapshot) => {
      const index = snapshot.runs.findIndex((run) => run.runId === runId);
      if (index < 0) throw new Error(`Run ${runId} does not exist`);
      const parsed = taskRunRecordSchema.safeParse({
        ...snapshot.runs[index],
        ...update,
      });
      if (!parsed.success) {
        throw new TypeError(`Invalid update for Run ${runId}`);
      }
      snapshot.runs[index] = parsed.data;
      return parsed.data;
    });
  }

  async #completeRun(
    taskId: string,
    runId: string,
    completion: TaskRunCompletion,
  ): Promise<TaskRunCompletionResult> {
    const parsedCompletion = taskRunCompletionSchema.safeParse(completion);
    if (!parsedCompletion.success) {
      throw new TypeError(`Invalid completion for Run ${runId}`);
    }
    return this.mutateSnapshot((snapshot) => {
      if (!snapshot.tasks.some((task) => task.taskId === taskId)) {
        return { outcome: 'task_not_found' };
      }
      const index = snapshot.runs.findIndex((run) => run.runId === runId);
      if (index < 0 || snapshot.runs[index]?.taskId !== taskId) {
        return { outcome: 'run_not_found' };
      }
      const current = snapshot.runs[index];
      if (!current) return { outcome: 'run_not_found' };
      if (current.status === 'completed') {
        return current.completion?.message === parsedCompletion.data.message
          ? { outcome: 'unchanged', run: current }
          : { outcome: 'completion_conflict', run: current };
      }
      if (current.status !== 'running') {
        return { outcome: 'run_not_running', run: current };
      }
      const parsedRun = taskRunRecordSchema.safeParse({
        ...current,
        status: 'completed',
        completion: parsedCompletion.data,
      });
      if (!parsedRun.success) {
        throw new TypeError(`Invalid completion update for Run ${runId}`);
      }
      snapshot.runs[index] = parsedRun.data;
      return { outcome: 'completed', run: parsedRun.data };
    });
  }
}
