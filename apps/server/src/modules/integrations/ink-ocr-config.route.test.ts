// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inkOcrConfigSchema } from '@huabu/shared';

import {
  getInkOcrConfig,
  resolveInkOcrConfiguration,
  setInkOcrConfig,
} from './ink-ocr-config.js';
import integrationsRoutes from './integrations.route.js';
import { EnvironmentSecretStore } from '../../security/environment-secret-store.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
import { registerLocalTestIdentity } from '../../test-support/local-identity.js';
import { recognizeInk } from '../agent/conversation/ink-ocr.js';

import type { FastifyInstance } from 'fastify';

const { secrets, writable, setSecret } = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  writable: { value: true },
  setSecret: vi.fn(),
}));

vi.mock('../../security/secret-store.js', () => ({
  getPersistedSecret: (id: string) => secrets.get(id) ?? null,
  getSecret: (id: string) =>
    secrets.get(id) ?? new EnvironmentSecretStore().get(id),
  isSecretStoreWritable: () => writable.value,
  setSecret,
  setSecrets: vi.fn(),
}));

const url = '/api/integrations/ink-ocr/config';
const oldEndpoint = 'https://old.cognitiveservices.azure.com/';
const newEndpoint = 'https://new.cognitiveservices.azure.com/';
let app: FastifyInstance;
let dataDir: string;

function storeRecord(endpoint: string | null, apiKey: string | null): void {
  secrets.set(
    SECRET_IDS.inkOcrConfig,
    JSON.stringify({ version: 1, endpoint, apiKey }),
  );
}

function storeLegacy(): string {
  const raw = JSON.stringify({ endpoint: oldEndpoint });
  writeFileSync(join(dataDir, 'ink-ocr-config.json'), raw);
  secrets.set(SECRET_IDS.inkOcrApiKey, 'old-private-key');
  return raw;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pauseNextWrite() {
  const started = deferred();
  const completion = deferred();
  setSecret.mockImplementationOnce(async (id: string, value: string) => {
    started.resolve();
    await completion.promise;
    secrets.set(id, value);
  });
  return { started: started.promise, completion };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'huabu-ocr-config-'));
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  vi.stubEnv('VISION_KEY', '');
  vi.stubEnv('VISION_ENDPOINT', '');
  secrets.clear();
  writable.value = true;
  setSecret
    .mockReset()
    .mockImplementation(async (id: string, value: string | null) => {
      if (value === null) secrets.delete(id);
      else secrets.set(id, value);
    });
  app = Fastify({ logger: false });
  registerLocalTestIdentity(app);
  await app.register(integrationsRoutes, { prefix: '/api/integrations' });
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Azure Ink OCR settings', () => {
  it('reports an unconfigured masked read model', async () => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(inkOcrConfigSchema.parse(response.json())).toEqual(response.json());
    expect(response.json()).toEqual({
      provider: 'azure-vision',
      endpoint: null,
      endpointSource: 'none',
      keySource: 'none',
      hasStoredKey: false,
      configured: false,
    });
  });

  it('saves settings, keeps the key out of config files and responses, and preserves omitted fields', async () => {
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: {
        endpoint: ' https://stored.cognitiveservices.azure.com/ ',
        apiKey: ' stored-private-key ',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      endpoint: 'https://stored.cognitiveservices.azure.com/',
      endpointSource: 'stored',
      keySource: 'stored',
      hasStoredKey: true,
      configured: true,
    });
    expect(response.body).not.toContain('stored-private-key');
    expect(setSecret).toHaveBeenCalledWith(
      SECRET_IDS.inkOcrConfig,
      JSON.stringify({
        version: 1,
        endpoint: 'https://stored.cognitiveservices.azure.com/',
        apiKey: 'stored-private-key',
      }),
    );
    expect(existsSync(join(dataDir, 'ink-ocr-config.json'))).toBe(false);
    await app.inject({
      method: 'PUT',
      url,
      payload: { endpoint: 'https://replacement.cognitiveservices.azure.com/' },
    });
    expect(resolveInkOcrConfiguration()).toEqual({
      endpoint: 'https://replacement.cognitiveservices.azure.com/',
      key: 'stored-private-key',
    });
    expect(setSecret).toHaveBeenCalledTimes(2);
  });

  it('restores environment fallbacks on removal without deleting the environment or unrelated settings', async () => {
    vi.stubEnv('VISION_KEY', 'environment-private-key');
    vi.stubEnv(
      'VISION_ENDPOINT',
      'https://environment.cognitiveservices.azure.com/',
    );
    expect(getInkOcrConfig()).toMatchObject({
      keySource: 'environment',
      endpointSource: 'environment',
      hasStoredKey: false,
      configured: true,
    });
    await app.inject({
      method: 'PUT',
      url,
      payload: {
        endpoint: 'https://stored.cognitiveservices.azure.com/',
        apiKey: 'stored-private-key',
      },
    });
    const removed = await app.inject({
      method: 'PUT',
      url,
      payload: { apiKey: null },
    });
    expect(removed.json()).toMatchObject({
      keySource: 'environment',
      endpointSource: 'stored',
      hasStoredKey: false,
      configured: true,
    });
    const reset = await app.inject({
      method: 'PUT',
      url,
      payload: { endpoint: null },
    });
    expect(reset.json()).toMatchObject({
      endpoint: 'https://environment.cognitiveservices.azure.com/',
      endpointSource: 'environment',
    });
    expect(process.env.VISION_KEY).toBe('environment-private-key');
    expect(resolveInkOcrConfiguration().key).toBe('environment-private-key');
  });

  it('reports incomplete configuration without claiming that a connection was tested', async () => {
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: { apiKey: 'private-key' },
    });
    expect(response.json()).toMatchObject({
      hasStoredKey: true,
      configured: false,
    });
  });

  it.each(['GET', 'PUT'] as const)(
    'requires the owner for %s',
    async (method) => {
      const response = await app.inject({
        method,
        url,
        remoteAddress: '192.0.2.10',
        ...(method === 'PUT' ? { payload: { apiKey: 'private-key' } } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(setSecret).not.toHaveBeenCalled();
    },
  );

  it.each([
    { endpoint: 'http://insecure.example/' },
    { endpoint: 'https://user:password@example.com/' },
    { endpoint: 'https://example.com/?token=private' },
    { endpoint: 'https://example.com/#private' },
    { endpoint: 'invalid' },
    { endpoint: 'https://gateway.example/' },
    { endpoint: 'https://resource.cognitiveservices.azure.com.evil.example/' },
    { endpoint: 'https://resource.cognitiveservices.azure.com:8443/' },
    { endpoint: 'https://resource.cognitiveservices.azure.com/api' },
    { apiKey: ' ' },
    { apiKey: 5 },
    { apiKey: 'a'.repeat(4097) },
    { endpoint: `https://example.com/${'a'.repeat(2048)}` },
    {},
    { provider: 'baidu' },
    { 'private-key': 'private-value' },
  ])('rejects malformed settings (%#)', async (payload) => {
    const response = await app.inject({ method: 'PUT', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: expect.any(String),
      code: 'validation_failed',
    });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('returns actionable endpoint guidance without echoing credentials', async () => {
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: {
        endpoint: 'https://private-user:private-password@gateway.example/',
        apiKey: 'private-api-key',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message:
        'Use an HTTPS Azure public-cloud resource root endpoint under cognitiveservices.azure.com or api.cognitive.microsoft.com, without credentials, query, fragment, or a nondefault port',
      code: 'validation_failed',
    });
    expect(response.body).not.toContain('private-');
    expect(response.body).not.toContain('gateway.example');
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('does not echo unknown property names in validation errors', async () => {
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: {
        apiKey: 'private-api-key',
        'private-property': 'private-value',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid Ink OCR configuration',
      code: 'validation_failed',
    });
    expect(response.body).not.toContain('private-');
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('preserves safe missing-update guidance', async () => {
    const response = await app.inject({ method: 'PUT', url, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Provide an endpoint or API key update',
      code: 'validation_failed',
    });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('rejects every settings mutation on a read-only store', async () => {
    writable.value = false;
    for (const apiKey of ['private-key', null]) {
      const response = await app.inject({
        method: 'PUT',
        url,
        payload: { apiKey },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('credential_store_read_only');
    }
    const endpoint = await app.inject({
      method: 'PUT',
      url,
      payload: { endpoint: 'https://resource.cognitiveservices.azure.com/' },
    });
    expect(endpoint.statusCode).toBe(409);
    const reset = await app.inject({
      method: 'PUT',
      url,
      payload: { endpoint: null, apiKey: null },
    });
    expect(reset.statusCode).toBe(409);
    expect(reset.json().message).toContain('Ink OCR settings');
    expect(existsSync(join(dataDir, 'ink-ocr-config.json'))).toBe(false);
    expect(setSecret).not.toHaveBeenCalled();
  });

  describe('Single-record OCR configuration', () => {
    it('never consults legacy values after a canonical record exists', () => {
      storeLegacy();
      storeRecord(newEndpoint, null);
      writeFileSync(
        join(dataDir, 'ink-ocr-config.json'),
        'damaged legacy configuration',
      );
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: newEndpoint,
        key: null,
      });
      expect(getInkOcrConfig()).toMatchObject({
        endpoint: newEndpoint,
        hasStoredKey: false,
        keySource: 'none',
        configured: false,
      });
    });

    it('migrates on the first successful patch without changing legacy data', async () => {
      const legacy = storeLegacy();
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: oldEndpoint,
        key: 'old-private-key',
      });
      expect(setSecret).not.toHaveBeenCalled();
      await setInkOcrConfig({ endpoint: newEndpoint });
      expect(setSecret).toHaveBeenCalledExactlyOnceWith(
        SECRET_IDS.inkOcrConfig,
        JSON.stringify({
          version: 1,
          endpoint: newEndpoint,
          apiKey: 'old-private-key',
        }),
      );
      expect(secrets.get(SECRET_IDS.inkOcrApiKey)).toBe('old-private-key');
      expect(readFileSync(join(dataDir, 'ink-ocr-config.json'), 'utf8')).toBe(
        legacy,
      );
    });

    it.each(['legacy', 'canonical'] as const)(
      'keeps the complete %s pair during a pending write and on failure, then releases the queue',
      async (source) => {
        const legacy = storeLegacy();
        if (source === 'canonical') storeRecord(oldEndpoint, 'old-private-key');
        const pending = pauseNextWrite();
        const update = setInkOcrConfig({
          endpoint: newEndpoint,
          apiKey: 'new-private-key',
        });
        const rejected = expect(update).rejects.toThrow(
          'Unable to save Ink OCR configuration',
        );
        await pending.started;
        expect(resolveInkOcrConfiguration()).toEqual({
          endpoint: oldEndpoint,
          key: 'old-private-key',
        });
        const queued = setInkOcrConfig({ apiKey: 'queued-private-key' });
        expect(setSecret).toHaveBeenCalledTimes(1);
        pending.completion.reject(new Error('private-key write failure'));
        await rejected;
        await queued;
        expect(resolveInkOcrConfiguration()).toEqual({
          endpoint: oldEndpoint,
          key: 'queued-private-key',
        });
        expect(readFileSync(join(dataDir, 'ink-ocr-config.json'), 'utf8')).toBe(
          legacy,
        );
        expect(secrets.get(SECRET_IDS.inkOcrApiKey)).toBe('old-private-key');
      },
    );

    it('serializes concurrent patches without losing updates and returns each captured read model', async () => {
      storeRecord(oldEndpoint, 'old-private-key');
      const pending = pauseNextWrite();
      const first = setInkOcrConfig({ endpoint: newEndpoint });
      await pending.started;
      const second = setInkOcrConfig({
        endpoint: null,
        apiKey: 'new-private-key',
      });
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: oldEndpoint,
        key: 'old-private-key',
      });
      expect(setSecret).toHaveBeenCalledTimes(1);
      pending.completion.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({
        endpoint: newEndpoint,
        endpointSource: 'stored',
        configured: true,
      });
      expect(secondResult).toMatchObject({
        endpoint: null,
        hasStoredKey: true,
        configured: false,
      });

      const endpointPatch = setInkOcrConfig({ endpoint: newEndpoint });
      const keyPatch = setInkOcrConfig({ apiKey: 'final-private-key' });
      await Promise.all([endpointPatch, keyPatch]);
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: newEndpoint,
        key: 'final-private-key',
      });
    });

    it('exposes only complete old or new pairs throughout an asynchronous write', async () => {
      storeRecord(oldEndpoint, 'old-private-key');
      const pending = pauseNextWrite();
      const update = setInkOcrConfig({
        endpoint: newEndpoint,
        apiKey: 'new-private-key',
      });
      await pending.started;
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: oldEndpoint,
        key: 'old-private-key',
      });
      pending.completion.resolve();
      await update;
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: newEndpoint,
        key: 'new-private-key',
      });
    });

    it('persists explicit nulls that mask both legacy overrides, with environment-only fallback', async () => {
      const legacy = storeLegacy();
      await setInkOcrConfig({ endpoint: null, apiKey: null });
      expect(secrets.get(SECRET_IDS.inkOcrConfig)).toBe(
        JSON.stringify({ version: 1, endpoint: null, apiKey: null }),
      );
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: null,
        key: null,
      });
      expect(getInkOcrConfig()).toMatchObject({
        keySource: 'none',
        hasStoredKey: false,
        configured: false,
      });
      vi.stubEnv('VISION_ENDPOINT', newEndpoint);
      vi.stubEnv('VISION_KEY', 'environment-private-key');
      expect(resolveInkOcrConfiguration()).toEqual({
        endpoint: newEndpoint,
        key: 'environment-private-key',
      });
      expect(getInkOcrConfig()).toMatchObject({
        keySource: 'environment',
        endpointSource: 'environment',
        hasStoredKey: false,
        configured: true,
      });
      expect(readFileSync(join(dataDir, 'ink-ocr-config.json'), 'utf8')).toBe(
        legacy,
      );
      expect(secrets.get(SECRET_IDS.inkOcrApiKey)).toBe('old-private-key');
    });

    it('does not persist an environment fallback during lazy migration', async () => {
      vi.stubEnv('VISION_KEY', 'environment-private-key');
      await setInkOcrConfig({ endpoint: newEndpoint });
      expect(secrets.get(SECRET_IDS.inkOcrConfig)).toBe(
        JSON.stringify({ version: 1, endpoint: newEndpoint, apiKey: null }),
      );
      vi.stubEnv('VISION_KEY', 'rotated-environment-key');
      expect(resolveInkOcrConfiguration().key).toBe('rotated-environment-key');
      vi.stubEnv('VISION_KEY', '');
      expect(getInkOcrConfig().configured).toBe(false);
    });

    it.each([
      '',
      'private-key malformed json',
      'null',
      '{}',
      JSON.stringify({ version: 2, endpoint: null, apiKey: 'private-key' }),
      JSON.stringify({ version: 1, endpoint: null }),
      JSON.stringify({ version: 1, endpoint: null, apiKey: 'a'.repeat(4097) }),
      JSON.stringify({
        version: 1,
        endpoint: null,
        apiKey: 'private-key',
        extra: true,
      }),
      ' '.repeat(32 * 1024 + 1),
    ])(
      'fails closed with redacted errors for corrupt canonical records (%#)',
      async (raw) => {
        storeLegacy();
        vi.stubEnv('VISION_ENDPOINT', newEndpoint);
        vi.stubEnv('VISION_KEY', 'environment-private-key');
        secrets.set(SECRET_IDS.inkOcrConfig, raw);
        expect(() => resolveInkOcrConfiguration()).toThrow(
          new Error('Invalid stored Ink OCR configuration'),
        );
        const read = await app.inject({ method: 'GET', url });
        expect(read.statusCode).toBe(500);
        expect(read.body).not.toContain('private-key');
        const write = await app.inject({
          method: 'PUT',
          url,
          payload: { apiKey: null },
        });
        expect(write.statusCode).toBe(500);
        expect(write.body).not.toContain('private-key');
        expect(setSecret).not.toHaveBeenCalled();
      },
    );

    it.each([
      { endpoint: 'https://gateway.example/' },
      { apiKey: '' },
      { apiKey: 'a'.repeat(4097) },
      {},
    ])('validates direct service callers (%#)', async (update) => {
      await expect(setInkOcrConfig(update)).rejects.toThrow(
        new Error('Invalid Ink OCR configuration update'),
      );
      expect(setSecret).not.toHaveBeenCalled();
    });

    it('rejects endpoint-only direct service writes without secure storage', async () => {
      writable.value = false;
      await expect(setInkOcrConfig({ endpoint: newEndpoint })).rejects.toThrow(
        'Credential storage is read-only',
      );
      expect(setSecret).not.toHaveBeenCalled();
    });

    it.each(['environment', 'legacy', 'canonical'] as const)(
      'blocks outbound fetch for unsafe %s endpoints without leaking configuration',
      async (source) => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const warn = vi.spyOn(app.log, 'warn');
        for (const endpoint of [
          'https://gateway.example/',
          'https://127.0.0.1/',
          'https://resource.cognitiveservices.azure.com.evil.example/',
          'https://resource.privatelink.cognitiveservices.azure.com/',
          'https://resource.cognitiveservices.azure.us/',
          'https://resource.cognitiveservices.azure.com:8443/',
          'https://resource.cognitiveservices.azure.com/api',
          'https://resource.cognitiveservices.azure.com/?key=private-key',
        ]) {
          if (source === 'environment') {
            vi.stubEnv('VISION_ENDPOINT', endpoint);
            vi.stubEnv('VISION_KEY', 'private-key');
            expect(inkOcrConfigSchema.parse(getInkOcrConfig())).toMatchObject({
              endpoint: null,
              configured: false,
            });
          } else if (source === 'legacy') {
            writeFileSync(
              join(dataDir, 'ink-ocr-config.json'),
              JSON.stringify({ endpoint }),
            );
            secrets.set(SECRET_IDS.inkOcrApiKey, 'private-key');
          } else {
            storeRecord(endpoint, 'private-key');
          }
          expect(
            await recognizeInk({
              raster: {
                png: Buffer.from('fake-image'),
                width: 10,
                height: 10,
                originNodeIds: ['ink'],
              },
              logger: app.log,
            }),
          ).toBeUndefined();
        }
        expect(fetchMock).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'config_error' }),
          '[ink-ocr] recognition completed',
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-key');
      },
    );
  });

  it('surfaces persistence failures without disclosing credential details', async () => {
    setSecret.mockRejectedValueOnce(new Error('private-key failure'));
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: { apiKey: 'private-key' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private-key');
    expect(response.json().code).toBe('ink_ocr_config_write_failed');
  });

  it('does not silently use an environment endpoint when stored config is damaged', async () => {
    vi.stubEnv('VISION_ENDPOINT', 'https://environment.example/');
    writeFileSync(join(dataDir, 'ink-ocr-config.json'), '{"endpoint":');
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe('ink_ocr_config_read_failed');
    expect(() => resolveInkOcrConfiguration()).toThrow();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(app.log, 'warn');
    expect(
      await recognizeInk({
        raster: {
          png: Buffer.from('test-image'),
          width: 100,
          height: 100,
          originNodeIds: ['ink'],
        },
        logger: app.log,
      }),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'config_error' }),
      '[ink-ocr] recognition completed',
    );
  });

  it('never reflects credentials embedded in an invalid environment endpoint', async () => {
    vi.stubEnv(
      'VISION_ENDPOINT',
      'https://private-user:private-password@example.com/',
    );
    const response = await app.inject({ method: 'GET', url });
    expect(response.json()).toMatchObject({
      endpoint: null,
      endpointSource: 'environment',
      configured: false,
    });
    expect(response.body).not.toContain('private-user');
    expect(response.body).not.toContain('private-password');
  });

  it('uses UI-saved credentials on the next OCR call without restart or a live Azure request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      Response.json({
        readResult: { blocks: [{ lines: [{ text: 'handwriting' }] }] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const params = {
      raster: {
        png: Buffer.from('test-image'),
        width: 100,
        height: 100,
        originNodeIds: ['ink'],
      },
      logger: app.log,
    };
    await app.inject({
      method: 'PUT',
      url,
      payload: {
        endpoint: 'https://resource.cognitiveservices.azure.com/',
        apiKey: 'first-private-key',
      },
    });
    expect(await recognizeInk(params)).toMatchObject({
      provider: 'azure-vision',
    });
    expect(
      fetchMock.mock.calls[0]?.[1].headers['Ocp-Apim-Subscription-Key'],
    ).toBe('first-private-key');
    await app.inject({
      method: 'PUT',
      url,
      payload: { apiKey: 'second-private-key' },
    });
    await recognizeInk(params);
    expect(
      fetchMock.mock.calls[1]?.[1].headers['Ocp-Apim-Subscription-Key'],
    ).toBe('second-private-key');
  });
});
