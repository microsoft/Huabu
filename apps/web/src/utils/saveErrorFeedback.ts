// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

let callerOwnedSaves = 0;
let recoveryHolds = 0;
const pendingRecovery = new Set<() => void>();

export function saveErrorsHandledByCaller(): boolean {
  return callerOwnedSaves > 0;
}

function releaseRecovery(): void {
  if (callerOwnedSaves || recoveryHolds) return;
  for (const callback of pendingRecovery) {
    pendingRecovery.delete(callback);
    callback();
  }
}

/** Keep recovery actions available after the caller's error surface closes. */
export function holdSaveErrorRecovery(): () => void {
  recoveryHolds++;
  return () => {
    recoveryHolds--;
    releaseRecovery();
  };
}

export function showSaveErrorRecovery(
  callback: () => void,
): (() => void) | undefined {
  if (!callerOwnedSaves && !recoveryHolds) {
    callback();
    return;
  }
  pendingRecovery.add(callback);
  return () => {
    pendingRecovery.delete(callback);
  };
}

/** Covers debounced and already-running writes in this renderer's save barrier. */
export async function withSaveErrorsHandledByCaller<T>(
  operation: () => Promise<T>,
): Promise<T> {
  callerOwnedSaves++;
  try {
    return await operation();
  } finally {
    callerOwnedSaves--;
    releaseRecovery();
  }
}
