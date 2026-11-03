// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

let callerOwnedSaves = 0;

export function saveErrorsHandledByCaller(): boolean {
  return callerOwnedSaves > 0;
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
  }
}
