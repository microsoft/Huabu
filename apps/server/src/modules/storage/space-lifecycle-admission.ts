// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Process-local coordination for one Space's blob/structured lifecycle. */

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

  async acquireDelete(): Promise<() => void> {
    await this.#acquireDelete();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseDelete();
    };
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

async function withPutAdmission<T>(
  workspacePath: string,
  canvasId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const gateKey = key(workspacePath, canvasId);
  const gate = gateFor(workspacePath, canvasId);
  try {
    return await gate.withPut(operation);
  } finally {
    if (gate.idle && gates.get(gateKey) === gate) gates.delete(gateKey);
  }
}

export function withSpacePutAdmission<T>(
  workspacePath: string,
  canvasId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withPutAdmission(workspacePath, canvasId, operation);
}

export async function beginSpaceDeleteAdmission(
  workspacePath: string,
  canvasId: string,
): Promise<() => void> {
  const gateKey = key(workspacePath, canvasId);
  const gate = gateFor(workspacePath, canvasId);
  const releaseGate = await gate.acquireDelete();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (gate.idle && gates.get(gateKey) === gate) gates.delete(gateKey);
  };
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
