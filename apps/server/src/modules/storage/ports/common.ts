// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared vocabulary for the storage ports.
 *
 * `StructuredStore` and `BlobStore` are independent — neither imports the
 * other — so the handful of types both need live here.
 */

/** Liveness of one backend connection, as reported by `health()`. */
export interface StorageHealth {
  ok: boolean;
  /** Backend kind, echoed so a caller aggregating several can label them. */
  kind: string;
  /** Human-readable cause when `ok` is false. */
  detail?: string;
}
