// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  getBundledServicePackages,
  readServicePackageFile,
} from './package-loader.js';

describe('bundled Service packages', () => {
  it('loads all current Settings services from validated YAML', () => {
    const packages = getBundledServicePackages();
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

  it('exposes real Agent files only when the manifest declares Agent behavior', () => {
    expect(readServicePackageFile('image-gen', 'SKILL.md')).toContain(
      '# Image Generation',
    );
    expect(readServicePackageFile('web-search', 'client.mjs')).toContain(
      'createClient',
    );
    expect(
      readServicePackageFile('youtube-transcripts', 'SKILL.md'),
    ).toBeNull();
  });
});
