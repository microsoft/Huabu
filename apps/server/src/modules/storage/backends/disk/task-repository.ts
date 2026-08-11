// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import {
  taskRecordSchema,
  taskRunRecordSchema,
  taskStoreSnapshotSchema,
  type TaskRecord,
  type TaskRunRecord,
  type TaskStoreSnapshot,
} from '@huabu/shared';

import {
  assertSpaceMutationAllowed,
  withSpaceMutationAdmission,
} from './legacy/space-lifecycle-admission.js';
import { readDiskSpaceRecord } from './space-repository.js';
import { atomicWriteJson, readJsonStrict } from '../../../../utils/fs.js';
import { tasksPath } from '../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type {
  CanvasTaskRepository,
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

export class DiskCanvasTaskRepository implements CanvasTaskRepository {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `Canvas Task repository(${this.#store.canvasId}) belongs to an inactive workspace`,
      );
    }
  }

  private requireSpace(): void {
    assertSpaceMutationAllowed(this.#workspacePath, this.#store.canvasId);
    if (!readDiskSpaceRecord(this.#store)) {
      throw new Error(
        `Canvas Task repository(${this.#store.canvasId}) cannot write a missing Space`,
      );
    }
  }

  async read(): Promise<TaskStoreSnapshot> {
    this.assertActiveWorkspace();
    return readTaskStore(this.#store.canvasId);
  }

  async insertTask(task: TaskRecord): Promise<void> {
    const parsed = taskRecordSchema.safeParse(task);
    if (!parsed.success || parsed.data.canvasId !== this.#store.canvasId) {
      throw new TypeError(
        `Invalid Task record for Canvas ${this.#store.canvasId}`,
      );
    }
    await this.mutate((snapshot) => {
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

  async insertRun(run: TaskRunRecord): Promise<void> {
    const parsed = taskRunRecordSchema.safeParse(run);
    if (
      !parsed.success ||
      parsed.data.canvasIdSnapshot !== this.#store.canvasId
    ) {
      throw new TypeError(
        `Invalid Run record for Canvas ${this.#store.canvasId}`,
      );
    }
    await this.mutate((snapshot) => {
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

  async updateRun(
    runId: string,
    update: TaskRunUpdate,
  ): Promise<TaskRunRecord> {
    return this.mutate((snapshot) => {
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

  private async mutate<T>(
    apply: (snapshot: TaskStoreSnapshot) => T,
  ): Promise<T> {
    this.assertActiveWorkspace();
    const key = `${this.#workspacePath}\0${this.#store.canvasId}`;
    return withSpaceMutationAdmission(
      this.#workspacePath,
      this.#store.canvasId,
      () =>
        withTaskMutationMutex(key, () => {
          this.assertActiveWorkspace();
          this.requireSpace();
          const current = readTaskStore(this.#store.canvasId);
          const next: TaskStoreSnapshot = {
            version: 1,
            tasks: [...current.tasks],
            runs: [...current.runs],
          };
          const result = apply(next);
          atomicWriteJson(tasksPath(this.#store.canvasId), next);
          return result;
        }),
    );
  }
}
