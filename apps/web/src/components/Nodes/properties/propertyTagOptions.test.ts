// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { propertyTagOptions } from './propertyTagOptions';

it('collects the distinct values of one property across nodes, tags and text alike', () => {
  const nodes: { data?: Record<string, unknown> }[] = [
    { data: { properties: { Venue: ['UIST 2026'], Keywords: ['canvas'] } } },
    { data: { properties: { Venue: ' CHI 2026 ', Year: 2026 } } },
    { data: { properties: { Venue: ['UIST 2026', 'DIS 2026', ''] } } },
    { data: { properties: { toString: 'not a venue' } } },
    { data: {} },
    {},
  ];
  expect(propertyTagOptions(nodes, 'Venue')).toEqual([
    'CHI 2026',
    'DIS 2026',
    'UIST 2026',
  ]);
  expect(propertyTagOptions(nodes, 'Year')).toEqual([]);
  expect(propertyTagOptions(nodes, 'valueOf')).toEqual([]);
});
