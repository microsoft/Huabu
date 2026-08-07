// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface SecretStore {
  /** Stable backend name for diagnostics. */
  readonly kind: string;
  /** Whether settings may persist values to this backend. */
  readonly writable: boolean;
  /** Prepare the backend before the HTTP server starts. */
  initialize(): Promise<void>;
  /** Synchronous read from an initialized in-memory view. */
  get(id: string): string | null;
  /** Persist or delete a value. Null means delete. */
  set(id: string, value: string | null): Promise<void>;
  /**
   * Persist or delete several values in one shot. Backends that can do so
   * apply the batch atomically (all-or-nothing); others fall back to a
   * best-effort sequential apply. Null values delete.
   */
  setMany(updates: Record<string, string | null>): Promise<void>;
}
