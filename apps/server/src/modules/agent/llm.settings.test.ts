import { describe, expect, it } from 'vitest';

import { getAvailableProviders } from './llm.js';

describe('LLM provider catalog', () => {
  it('describes each provider base URL default and override capability', () => {
    const providers = new Map(
      getAvailableProviders().map((provider) => [provider.id, provider]),
    );

    expect(providers.get('openai')?.baseUrl).toEqual({
      default: 'https://api.openai.com/v1',
      overridable: true,
    });
    expect(providers.get('anthropic')?.baseUrl).toEqual({
      default: 'https://api.anthropic.com',
      overridable: true,
    });
    expect(providers.get('azure-openai')?.baseUrl).toEqual({
      overridable: true,
    });
    expect(providers.get('github-copilot')?.baseUrl).toMatchObject({
      default: expect.any(String),
      overridable: false,
    });
  });
});

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
