// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setImageConfig: vi.fn(),
  setIntegrationsConfig: vi.fn(),
  setInkOcrConfig: vi.fn(),
}));

vi.mock('../agent/llm.js', () => ({
  getImageConfig: () => ({
    provider: 'azure-openai',
    authenticated: true,
    baseUrl: 'https://images.example.com',
    model: 'image-deployment',
    modelFamily: 'gpt-image-2',
    apiVersion: '2025-04-01-preview',
    quality: 'low',
  }),
  getAzureImageConfig: () => ({
    endpoint: 'https://images.example.com',
    deployment: 'image-deployment',
    apiKey: 'image-secret',
    apiVersion: '2025-04-01-preview',
    modelFamily: 'gpt-image-2',
    quality: 'low',
  }),
  setImageConfig: mocks.setImageConfig,
}));

vi.mock('../integrations/integrations.js', () => ({
  getTavilyApiKey: () => 'tavily-secret',
  getRapidApiKey: () => 'rapid-secret',
  setIntegrationsConfig: mocks.setIntegrationsConfig,
}));

vi.mock('../integrations/ink-ocr-config.js', () => ({
  getInkOcrConfig: () => ({
    provider: 'azure-vision',
    endpoint: 'https://vision.cognitiveservices.azure.com',
    endpointSource: 'stored',
    keySource: 'stored',
    hasStoredKey: true,
    configured: true,
  }),
  resolveInkOcrConfiguration: () => ({
    endpoint: 'https://vision.cognitiveservices.azure.com',
    key: 'vision-secret',
  }),
  setInkOcrConfig: mocks.setInkOcrConfig,
}));

vi.mock('../../security/secret-store.js', () => ({
  getSecret: () => 'image-secret',
}));

import { getBundledCapabilityPackages } from './package-loader.js';
import { CapabilityProvisionService } from './provision-service.js';

function service() {
  return new CapabilityProvisionService(
    new Map(
      [...getBundledCapabilityPackages()].map(([id, capability]) => [
        id,
        capability.manifest,
      ]),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Capability Provision Service storage bindings', () => {
  it('reads every existing owner without causing a persistence write', () => {
    const provision = service();

    expect(provision.list()).toHaveLength(4);
    expect(provision.getConfig('image-gen').configured).toBe(true);
    expect(provision.getConfig('web-search').values.apiKey).toBeNull();
    expect(provision.resolveForServer('youtube-transcripts')).toEqual({
      apiKey: 'rapid-secret',
    });

    expect(mocks.setImageConfig).not.toHaveBeenCalled();
    expect(mocks.setIntegrationsConfig).not.toHaveBeenCalled();
    expect(mocks.setInkOcrConfig).not.toHaveBeenCalled();
  });

  it('writes updates back through the registered existing owner', async () => {
    const provision = service();

    await provision.updateConfig('image-gen', {
      baseUrl: 'https://next.example.com',
    });
    await provision.updateConfig('web-search', { apiKey: 'next-tavily' });
    await provision.updateConfig('ink-ocr', { apiKey: null });

    expect(mocks.setImageConfig).toHaveBeenCalledWith({
      baseUrl: 'https://next.example.com',
    });
    expect(mocks.setIntegrationsConfig).toHaveBeenCalledWith({
      tavilyApiKey: 'next-tavily',
    });
    expect(mocks.setInkOcrConfig).toHaveBeenCalledWith({ apiKey: null });
  });

  it('leases only declared fields for configured External packages', () => {
    const lease = service().lease('image-gen');

    expect(lease).toMatchObject({
      id: 'image-gen',
      client: 'client.mjs',
      config: {
        baseUrl: 'https://images.example.com',
        apiKey: 'image-secret',
      },
    });
    expect(Object.keys(lease.config).sort()).toEqual(
      [
        'apiKey',
        'apiVersion',
        'baseUrl',
        'model',
        'modelFamily',
        'provider',
        'quality',
      ].sort(),
    );
    expect(() => service().lease('ink-ocr')).toThrow(
      'not available to External Agents',
    );
  });
});
