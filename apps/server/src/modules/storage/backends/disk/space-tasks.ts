// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

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

import { tasksPath } from './layout.js';
import { readDiskSpaceRecord } from './space-record.js';
import { atomicWriteJson, readJsonStrict } from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';
import { assertSpaceMutationAllowed } from '../../space-lifecycle-admission.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type {
  SpaceTaskRuns,
  SpaceTasks,
  TaskRunCompletionResult,
  TaskRunUpdate,
} from '../../ports/structured.js';

const taskMutationChains = new Map<string, Promise<unknown>>();

async function withTaskMutationMutex<T>(
  key: string,
  mutation: () => T | Promise<T>,
): Promise<T> {
  const previous = taskMutationChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(mutation);
  taskMutationChains.set(key, next);
  try {
    return await next;
  } finally {
    if (taskMutationChains.get(key) === next) {
      taskMutationChains.delete(key);
    }
  }
}

function readTaskStore(canvasId: string): TaskStoreSnapshot {
  const value = readJsonStrict<unknown>(tasksPath(canvasId));
  if (value === null) return { version: 1, tasks: [], runs: [] };
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

/**
 * Disk implementation of the Task ledger.
 *
 * Tasks and Runs share one file (`tasks.json`) and one mutation mutex, so the
 * `runs` facade is a frozen view over this same object rather than a second
 * store: the invariant that a Run references an existing Task is checked
 * against the snapshot both writers read.
 */
export class DiskSpaceTasks implements SpaceTasks {
  readonly runs: SpaceTaskRuns;

  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
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

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `Space Tasks(${this.#store.canvasId}) belong to an inactive workspace`,
      );
    }
  }

  #requireSpace(): void {
    assertSpaceMutationAllowed(this.#workspacePath, this.#store.canvasId);
    if (!readDiskSpaceRecord(this.#store)) {
      throw new Error(
        `Space Tasks(${this.#store.canvasId}) cannot write a missing Space`,
      );
    }
  }

  async read(): Promise<TaskStoreSnapshot> {
    this.#assertActiveWorkspace();
    return readTaskStore(this.#store.canvasId);
  }

  async create(task: TaskRecord): Promise<void> {
    const parsed = taskRecordSchema.safeParse(task);
    if (!parsed.success || parsed.data.canvasId !== this.#store.canvasId) {
      throw new TypeError(
        `Invalid Task record for Canvas ${this.#store.canvasId}`,
      );
    }
    await this.#mutate((snapshot) => {
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
    if (
      !parsed.success ||
      parsed.data.canvasIdSnapshot !== this.#store.canvasId
    ) {
      throw new TypeError(
        `Invalid Run record for Canvas ${this.#store.canvasId}`,
      );
    }
    await this.#mutate((snapshot) => {
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

  async #mutate<T>(apply: (snapshot: TaskStoreSnapshot) => T): Promise<T> {
    this.#assertActiveWorkspace();
    const key = `${this.#workspacePath}\0${this.#store.canvasId}`;
    return withTaskMutationMutex(key, () => {
      this.#assertActiveWorkspace();
      this.#requireSpace();
      const current = readTaskStore(this.#store.canvasId);
      const next: TaskStoreSnapshot = {
        version: 1,
        tasks: [...current.tasks],
        runs: [...current.runs],
      };
      const result = apply(next);
      atomicWriteJson(tasksPath(this.#store.canvasId), next);
      return result;
    });
  }
}
