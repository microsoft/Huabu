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
    expect(packages.get('youtube-transcripts')?.manifest.package.files).toEqual(
      [],
    );
    expect(packages.get('ink-ocr')?.manifest.package.files).toEqual([]);
  });

  it('exposes only exact files declared by the package', () => {
    expect(readServicePackageFile('image-gen', 'SKILL.md')).toContain(
      '# Azure OpenAI Image Generation',
    );
    expect(readServicePackageFile('web-search', 'entry.mjs')).toContain(
      'search',
    );
    expect(readServicePackageFile('image-gen', 'entry.test.ts')).toBeNull();
    expect(
      readServicePackageFile('youtube-transcripts', 'SKILL.md'),
    ).toBeNull();
  });
});
