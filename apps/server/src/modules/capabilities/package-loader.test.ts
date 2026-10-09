// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  getBundledCapabilityPackages,
  readCapabilityPackageFile,
} from './package-loader.js';

describe('bundled Capability packages', () => {
  it('loads all current Settings capabilities from validated YAML', () => {
    const packages = getBundledCapabilityPackages();
    expect([...packages.keys()]).toEqual([
      'image-gen',
      'web-search',
      'youtube-transcripts',
      'ink-ocr',
    ]);
    expect(packages.get('image-gen')?.manifest.storage.namespace).toBe(
      'llm.imageConfig',
    );
    expect(packages.get('youtube-transcripts')?.manifest.agent).toBeUndefined();
    expect(packages.get('ink-ocr')?.manifest.agent).toBeUndefined();
  });

  it('exposes real Agent files only for External packages', () => {
    expect(readCapabilityPackageFile('image-gen', 'SKILL.md')).toContain(
      '# Image Generation',
    );
    expect(readCapabilityPackageFile('web-search', 'client.mjs')).toContain(
      'createClient',
    );
    expect(
      readCapabilityPackageFile('youtube-transcripts', 'SKILL.md'),
    ).toBeNull();
  });
});
