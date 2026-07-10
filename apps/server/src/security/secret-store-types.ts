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
}
