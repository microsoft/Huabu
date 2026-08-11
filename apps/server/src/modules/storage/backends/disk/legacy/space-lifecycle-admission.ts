// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Process-local coordination for one Disk Space's blob/record lifecycle. */

type Admission = () => void;

/** Writer-preferring gate: blob puts share admission; deletion is exclusive. */
class SpaceLifecycleGate {
  #readers = 0;
  #writer = false;
  readonly #waitingReaders: Admission[] = [];
  readonly #waitingWriters: Admission[] = [];

  async withPut<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquirePut();
    try {
      return await operation();
    } finally {
      this.#releasePut();
    }
  }

  async withDelete<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquireDelete();
    try {
      return await operation();
    } finally {
      this.#releaseDelete();
    }
  }

  get deletionPending(): boolean {
    return this.#writer || this.#waitingWriters.length > 0;
  }

  get idle(): boolean {
    return (
      this.#readers === 0 &&
      !this.#writer &&
      this.#waitingReaders.length === 0 &&
      this.#waitingWriters.length === 0
    );
  }

  #acquirePut(): Promise<void> {
    if (!this.#writer && this.#waitingWriters.length === 0) {
      this.#readers += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waitingReaders.push(() => {
        this.#readers += 1;
        resolve();
      });
    });
  }

  #acquireDelete(): Promise<void> {
    if (!this.#writer && this.#readers === 0) {
      this.#writer = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // Enqueue synchronously: structured mutators must see deletion pending
      // even while this writer is waiting for an admitted blob put to finish.
      this.#waitingWriters.push(() => {
        this.#writer = true;
        resolve();
      });
    });
  }

  #releasePut(): void {
    this.#readers -= 1;
    if (this.#readers === 0) this.#admitNext();
  }

  #releaseDelete(): void {
    this.#writer = false;
    this.#admitNext();
  }

  #admitNext(): void {
    if (this.#writer || this.#readers > 0) return;
    const writer = this.#waitingWriters.shift();
    if (writer) {
      writer();
      return;
    }
    const readers = this.#waitingReaders.splice(0);
    for (const reader of readers) reader();
  }
}

const gates = new Map<string, SpaceLifecycleGate>();

function key(workspacePath: string, canvasId: string): string {
  return `${workspacePath}\0${canvasId}`;
}

function gateFor(workspacePath: string, canvasId: string): SpaceLifecycleGate {
  const gateKey = key(workspacePath, canvasId);
  let gate = gates.get(gateKey);
  if (!gate) {
    gate = new SpaceLifecycleGate();
    gates.set(gateKey, gate);
  }
  return gate;
}

async function withAdmission<T>(
  workspacePath: string,
  canvasId: string,
  mode: 'put' | 'delete',
  operation: () => Promise<T>,
): Promise<T> {
  const gateKey = key(workspacePath, canvasId);
  const gate = gateFor(workspacePath, canvasId);
  try {
    return mode === 'put'
      ? await gate.withPut(operation)
      : await gate.withDelete(operation);
  } finally {
    if (gate.idle && gates.get(gateKey) === gate) gates.delete(gateKey);
  }
}

export function withSpacePutAdmission<T>(
  workspacePath: string,
  canvasId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withAdmission(workspacePath, canvasId, 'put', operation);
}

/** Admit a structured mutation as a reader against exclusive deletion. */
export function withSpaceMutationAdmission<T>(
  workspacePath: string,
  canvasId: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Structured callers cannot usefully resume after an exclusive delete has
  // removed the Space. Reject synchronously instead of queueing behind it;
  // the admission acquired immediately below still closes the race with a
  // delete that starts after this check.
  assertSpaceMutationAllowed(workspacePath, canvasId);
  return withAdmission(workspacePath, canvasId, 'put', operation);
}

export function withSpaceDeleteAdmission<T>(
  workspacePath: string,
  canvasId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withAdmission(workspacePath, canvasId, 'delete', operation);
}

/** Reject a structured mutation once deletion is active or queued. */
export function assertSpaceMutationAllowed(
  workspacePath: string,
  canvasId: string,
): void {
  if (gates.get(key(workspacePath, canvasId))?.deletionPending) {
    throw new Error(
      `Cannot mutate Space "${canvasId}" while deletion is pending`,
    );
  }
}
