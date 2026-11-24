// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect } from 'vitest';

import {
  toExecuteResponse,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { outcomeOf } from './execute-outcome.js';

/**
 * Assert that `second` answers a repeat of the request `first` answered.
 *
 * A replay is rebuilt from the stored outcome. It tells the caller what the
 * first call told it — per-edit and per-command results with the ids the
 * server assigned, versions, read version, order events, content revisions,
 * conflicts — and carries none of the first call's deltas, nodes or Review
 * records.
 */
export function expectReplayOf(
  first: ExecuteOnServerOutput,
  second: ExecuteOnServerOutput,
): void {
  expect(first.replayed).toBeUndefined();
  expect(second.replayed).toBe(true);
  expect(second.deltas).toEqual([]);
  expect(second.pendingEffects.mutatedNodes).toEqual([]);
  expect(second.changes).toBeUndefined();

  // What a page is told: the first answer without its deltas.
  const { deltas: _deltas, ...answer } = toExecuteResponse(first);
  expect(toExecuteResponse(second)).toEqual({ ...answer, replayed: true });

  // The outcome itself, command echo aside (kept only for the Agent route).
  const { commands: _echo, ...outcome } = outcomeOf(first, false);
  expect(second.outcome).toMatchObject(outcome);

  // The in-process fields callers read.
  expect(second.edits).toEqual(first.edits);
  expect(
    second.results.map(({ command: _command, ...result }) => result),
  ).toEqual(first.results.map(({ command: _command, ...result }) => result));
  for (const field of [
    'canvasId',
    'fromVersion',
    'toVersion',
    'basis',
    'operationId',
    'runId',
    'orderEvents',
    'nodeContentRevisions',
    'viewConflicts',
  ] as const) {
    expect(second[field]).toEqual(first[field]);
  }
  expect(second.conflicts).toEqual(
    first.conflicts?.map(
      ({ currentContent: _currentContent, ...conflict }) => conflict,
    ),
  );
}
