// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inkOcrConfigSchema } from '@huabu/shared';

import {
  getInkOcrConfig,
  resolveInkOcrConfiguration,
} from './ink-ocr-config.js';
import integrationsRoutes from './integrations.route.js';
import { EnvironmentSecretStore } from '../../security/environment-secret-store.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
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
let app: FastifyInstance;
let dataDir: string;

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
        endpoint: ' https://stored.example/ ',
        apiKey: ' stored-private-key ',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      endpoint: 'https://stored.example/',
      endpointSource: 'stored',
      keySource: 'stored',
      hasStoredKey: true,
      configured: true,
    });
    expect(response.body).not.toContain('stored-private-key');
    expect(setSecret).toHaveBeenCalledWith(
      SECRET_IDS.inkOcrApiKey,
      'stored-private-key',
    );
    expect(
      JSON.parse(readFileSync(join(dataDir, 'ink-ocr-config.json'), 'utf8')),
    ).toEqual({
      endpoint: 'https://stored.example/',
    });
    await app.inject({
      method: 'PUT',
      url,
      payload: { endpoint: 'https://replacement.example/' },
    });
    expect(resolveInkOcrConfiguration()).toEqual({
      endpoint: 'https://replacement.example/',
      key: 'stored-private-key',
    });
    expect(setSecret).toHaveBeenCalledTimes(1);
  });

  it('restores environment fallbacks on removal without deleting the environment or unrelated settings', async () => {
    vi.stubEnv('VISION_KEY', 'environment-private-key');
    vi.stubEnv('VISION_ENDPOINT', 'https://environment.example/');
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
        endpoint: 'https://stored.example/',
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
      endpoint: 'https://environment.example/',
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
    { apiKey: ' ' },
    { apiKey: 5 },
    { apiKey: 'a'.repeat(4097) },
    { endpoint: `https://example.com/${'a'.repeat(2048)}` },
    {},
    { provider: 'baidu' },
  ])('rejects malformed settings (%#)', async (payload) => {
    const response = await app.inject({ method: 'PUT', url, payload });
    expect(response.statusCode).toBe(400);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('disables key mutation on a read-only store but allows non-secret endpoint updates', async () => {
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
      payload: { endpoint: 'https://resource.example/' },
    });
    expect(endpoint.statusCode).toBe(200);
    expect(setSecret).not.toHaveBeenCalled();
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
        endpoint: 'https://resource.example/',
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
