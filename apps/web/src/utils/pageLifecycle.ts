// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

let pageUnloading = false;

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    pageUnloading = true;
  });
  window.addEventListener('pageshow', () => {
    pageUnloading = false;
  });
}

export function isPageUnloading(): boolean {
  return pageUnloading;
}

export type PageCloseStage = 'settling' | 'importing' | 'updating' | 'saving';

type Preparation = {
  settle?: () => void;
  flush?: () => Promise<void>;
};

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export function createPageLifecycle() {
  const preparations = new Map<string, Preparation>();
  const pending = new Map<
    symbol,
    { stage: PageCloseStage; settled: Promise<void> }
  >();
  let generation = 0;
  let closing: { errors: unknown[]; signal: AbortSignal } | undefined;

  return {
    register(key: string, preparation: Preparation): () => void {
      preparations.set(key, preparation);
      return () => {
        if (preparations.get(key) === preparation) preparations.delete(key);
      };
    },

    run<T>(
      stage: 'importing' | 'updating',
      operation: () => Promise<T>,
    ): Promise<T> {
      const key = Symbol();
      generation++;
      let work: Promise<T>;
      try {
        work = operation();
      } catch (error) {
        work = Promise.reject(error);
      }
      const settled = work.then(
        () => {
          pending.delete(key);
        },
        (error: unknown) => {
          closing?.errors.push(error);
          pending.delete(key);
        },
      );
      pending.set(key, { stage, settled });
      return work;
    },

    async prepare(
      signal: AbortSignal,
      onStage?: (stage: PageCloseStage) => void,
    ): Promise<void> {
      if (closing && !closing.signal.aborted)
        throw new Error('Page close preparation is already in progress.');
      const request = { errors: [] as unknown[], signal };
      closing = request;
      try {
        signal.throwIfAborted();
        onStage?.('settling');
        for (const preparation of preparations.values()) preparation.settle?.();
        let previous: number;
        do {
          previous = generation;
          while (pending.size) {
            const operations = [...pending.values()];
            onStage?.(operations[0].stage);
            await untilAborted(
              Promise.all(operations.map((task) => task.settled)),
              signal,
            );
          }
          if (request.errors.length) throw request.errors[0];
          onStage?.('saving');
          for (const preparation of preparations.values()) {
            signal.throwIfAborted();
            if (preparation.flush)
              await untilAborted(preparation.flush(), signal);
          }
        } while (pending.size || previous !== generation);
        if (request.errors.length) throw request.errors[0];
      } finally {
        if (closing === request) closing = undefined;
      }
    },
  };
}

// Each desktop content renderer owns one independent page lifecycle.
export const pageLifecycle = createPageLifecycle();
