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

import { withImmediateTransaction } from './database.js';
import { parseJson, stringifyJson } from './rows.js';

import type { SqliteStoreContext } from './database.js';
import type {
  SpaceTaskRuns,
  SpaceTasks,
  TaskRunCompletionResult,
  TaskRunUpdate,
} from '../../ports/structured.js';

const EMPTY_TASKS: TaskStoreSnapshot = {
  version: 1,
  tasks: [],
  runs: [],
};

function validateSnapshot(value: unknown, canvasId: string): TaskStoreSnapshot {
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

function readSnapshot(
  context: SqliteStoreContext,
  canvasId: string,
): TaskStoreSnapshot {
  const row = context
    .database()
    .prepare('SELECT snapshot_json FROM tasks WHERE canvas_id = ?')
    .get(canvasId);
  if (row === undefined) {
    return { ...EMPTY_TASKS, tasks: [], runs: [] };
  }
  return validateSnapshot(
    parseJson(row['snapshot_json'], `Task store for Canvas ${canvasId}`),
    canvasId,
  );
}

export class SqliteSpaceTasks implements SpaceTasks {
  readonly runs: SpaceTaskRuns;

  readonly #context: SqliteStoreContext;
  readonly #canvasId: string;

  constructor(context: SqliteStoreContext, canvasId: string) {
    this.#context = context;
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
    this.#context.assertOpen();
    return readSnapshot(this.#context, this.#canvasId);
  }

  async create(task: TaskRecord): Promise<void> {
    const parsed = taskRecordSchema.safeParse(task);
    if (!parsed.success || parsed.data.canvasId !== this.#canvasId) {
      throw new TypeError(`Invalid Task record for Canvas ${this.#canvasId}`);
    }
    this.#mutate((snapshot) => {
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
    this.#mutate((snapshot) => {
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
    return this.#mutate((snapshot) => {
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
    return this.#mutate((snapshot) => {
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

  #mutate<T>(apply: (snapshot: TaskStoreSnapshot) => T): T {
    this.#context.assertMutationAllowed(this.#canvasId);
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      if (
        database
          .prepare('SELECT 1 AS present FROM spaces WHERE canvas_id = ?')
          .get(this.#canvasId)?.['present'] !== 1
      ) {
        throw new Error(
          `Space Tasks(${this.#canvasId}) cannot write a missing Space`,
        );
      }
      const current = readSnapshot(this.#context, this.#canvasId);
      const next: TaskStoreSnapshot = {
        version: 1,
        tasks: [...current.tasks],
        runs: [...current.runs],
      };
      const result = apply(next);
      database
        .prepare(
          `INSERT INTO tasks (canvas_id, snapshot_json)
           VALUES (?, ?)
           ON CONFLICT(canvas_id) DO UPDATE SET
             snapshot_json = excluded.snapshot_json`,
        )
        .run(
          this.#canvasId,
          stringifyJson(next, `Task store for Canvas ${this.#canvasId}`),
        );
      return result;
    });
  }
}
