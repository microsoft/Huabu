import { describe, it } from 'vitest';

/**
 * Executable backlog for `setLLMConfig`'s cross-subsystem write compensation.
 *
 * The api key lives in the SecretStore while provider/model live in a plain
 * config file, so the two cannot be written atomically. `setLLMConfig` rolls
 * the secret back when the config write fails, and logs + throws a
 * partial-commit error when the rollback itself fails.
 *
 * These paths are untested because `savePersistedStore` (writeFileSync) and the
 * module-level pino logger (also fs-backed) make a global `node:fs` mock break
 * the logger. Testing cleanly needs `savePersistedStore` / the config read
 * extracted into an injectable seam first.
 *
 * See docs/proposals/credential-storage-hardening-followups.md (item 2).
 */
describe('setLLMConfig cross-file write compensation', () => {
  it.todo('restores the previous api key when the config file write fails');
  it.todo(
    'throws a partial-commit error and logs when config write AND rollback both fail',
  );
});
