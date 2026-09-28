// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  inkOcrConfigUpdateSchema,
  inkOcrEndpointSchema,
} from './ink-ocr-config.js';

describe('Azure public-cloud OCR endpoints', () => {
  it.each([
    'https://my-resource.cognitiveservices.azure.com',
    'https://my-resource.cognitiveservices.azure.com/',
    'https://eastus.api.cognitive.microsoft.com/',
    'https://westus2.api.cognitive.microsoft.com:443/',
    'https://RESOURCE.COGNITIVESERVICES.AZURE.COM/',
    `https://${'a'.repeat(63)}.cognitiveservices.azure.com/`,
  ])('accepts direct resource or regional roots: %s', (endpoint) => {
    expect(inkOcrEndpointSchema.parse(` ${endpoint} `)).toBe(endpoint);
  });

  it.each([
    'https://gateway.example/',
    'http://resource.cognitiveservices.azure.com/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://10.0.0.1/',
    'https://resource.internal/',
    'https://resource.cognitiveservices.azure.cn/',
    'https://resource.cognitiveservices.azure.us/',
    'https://eastus.api.cognitive.azure.us/',
    'https://eastus.api.cognitive.azure.cn/',
    'https://cognitiveservices.azure.com/',
    'https://api.cognitive.microsoft.com/',
    'https://resource.cognitiveservices.azure.com.evil.example/',
    'https://evilcognitiveservices.azure.com/',
    'https://evilapi.cognitive.microsoft.com/',
    'https://resource.privatelink.cognitiveservices.azure.com/',
    'https://extra.resource.cognitiveservices.azure.com/',
    'https://extra.eastus.api.cognitive.microsoft.com/',
    'https://resource.cognitiveservices.azure.com./',
    'https://-resource.cognitiveservices.azure.com/',
    'https://resource-.cognitiveservices.azure.com/',
    'https://my_resource.cognitiveservices.azure.com/',
    `https://${'a'.repeat(64)}.cognitiveservices.azure.com/`,
    'https://user:private-key@resource.cognitiveservices.azure.com/',
    'https://@resource.cognitiveservices.azure.com/',
    'https://resource.cognitiveservices.azure.com:8443/',
    'https://resource.cognitiveservices.azure.com:80/',
    'https://resource.cognitiveservices.azure.com/api',
    'https://resource.cognitiveservices.azure.com//',
    'https://resource.cognitiveservices.azure.com/./',
    'https://resource.cognitiveservices.azure.com/path/..',
    'https://resource.cognitiveservices.azure.com/%2e',
    'https://resource.cognitiveservices.azure.com/?',
    'https://resource.cognitiveservices.azure.com/#',
    'https://resource.cognitiveservices.azure.com/?key=private-key',
    'https://resource.cognitiveservices.azure.com/#private-key',
    'https://resource.cognitiveservices.azure.com\\',
    'https://resou\nrce.cognitiveservices.azure.com/',
    'https://%72esource.cognitiveservices.azure.com/',
  ])('rejects non-public hosts and non-root URLs: %s', (endpoint) => {
    expect(inkOcrEndpointSchema.safeParse(endpoint).success).toBe(false);
  });
});

describe('OCR settings patches', () => {
  it('preserves omission and explicit null independently', () => {
    expect(inkOcrConfigUpdateSchema.parse({ apiKey: null })).toEqual({
      apiKey: null,
    });
    expect(inkOcrConfigUpdateSchema.parse({ endpoint: null })).toEqual({
      endpoint: null,
    });
    expect(
      inkOcrConfigUpdateSchema.parse({ endpoint: null, apiKey: null }),
    ).toEqual({ endpoint: null, apiKey: null });
    expect(inkOcrConfigUpdateSchema.parse({ apiKey: ' fake-key ' })).toEqual({
      apiKey: 'fake-key',
    });
    expect(
      inkOcrConfigUpdateSchema.parse({ apiKey: 'a'.repeat(4096) }).apiKey,
    ).toHaveLength(4096);
  });

  it.each([
    {},
    { apiKey: '' },
    { apiKey: ' ' },
    { apiKey: 'a'.repeat(4097) },
    { apiKey: 1 },
    { apiKey: null, unknown: true },
  ])('rejects empty, malformed, or unbounded patches (%#)', (patch) => {
    expect(inkOcrConfigUpdateSchema.safeParse(patch).success).toBe(false);
  });
});
