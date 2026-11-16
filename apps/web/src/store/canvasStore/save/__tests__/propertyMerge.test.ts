// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { rebasePropertyEdit } from '../propertyMerge';

const base = {
  properties: { Venue: 'UIST', Year: 2024 },
  propertyDisplayKeys: ['Venue', 'Year'],
};

describe('rebasePropertyEdit', () => {
  it('keeps an edit of a key the other save left alone', () => {
    const edit = { properties: { Venue: 'CHI' } };
    expect(
      rebasePropertyEdit(edit, base, {
        properties: { Venue: 'UIST', Year: 2025 },
        propertyDisplayKeys: ['Venue', 'Year'],
      }),
    ).toEqual(edit);
  });

  it('refuses when the other save changed, removed or added the same key', () => {
    expect(
      rebasePropertyEdit({ properties: { Venue: 'CHI' } }, base, {
        properties: { Venue: 'DIS', Year: 2024 },
      }),
    ).toBeNull();
    expect(
      rebasePropertyEdit({ properties: { Venue: 'CHI' } }, base, {
        properties: { Year: 2024 },
      }),
    ).toBeNull();
    expect(
      rebasePropertyEdit({ properties: { Venue: null } }, base, {
        properties: { Venue: 'DIS', Year: 2024 },
      }),
    ).toBeNull();
    expect(
      rebasePropertyEdit(
        {
          properties: { Status: 'Read' },
          propertyDisplayKeys: ['Venue', 'Year', 'Status'],
        },
        base,
        {
          properties: { ...base.properties, Status: 'Reading' },
          propertyDisplayKeys: ['Venue', 'Year', 'Status'],
        },
      ),
    ).toBeNull();
  });

  it('has nothing to refuse when the server already holds what the edit wants', () => {
    expect(
      rebasePropertyEdit({ properties: { Venue: 'CHI' } }, base, {
        properties: { Venue: 'CHI', Year: 2024 },
      }),
    ).toEqual({ properties: { Venue: 'CHI' } });
    expect(
      rebasePropertyEdit({ properties: { Venue: null } }, base, {
        properties: { Year: 2024 },
      }),
    ).toEqual({ properties: { Venue: null } });
  });

  it('adds its key to the display order the other save left', () => {
    expect(
      rebasePropertyEdit(
        {
          properties: { Status: 'Read' },
          propertyDisplayKeys: ['Venue', 'Year', 'Status'],
        },
        base,
        {
          properties: { ...base.properties, Rating: 5 },
          propertyDisplayKeys: ['Rating', 'Venue', 'Year'],
        },
      ),
    ).toEqual({
      properties: { Status: 'Read' },
      propertyDisplayKeys: ['Rating', 'Venue', 'Year', 'Status'],
    });
  });

  it('removes its key from, and renames its key in, the display order the other save left', () => {
    const server = {
      properties: { ...base.properties, Rating: 5 },
      propertyDisplayKeys: ['Year', 'Venue', 'Rating'],
    };
    expect(
      rebasePropertyEdit(
        { properties: { Venue: null }, propertyDisplayKeys: ['Year'] },
        base,
        server,
      ),
    ).toEqual({
      properties: { Venue: null },
      propertyDisplayKeys: ['Year', 'Rating'],
    });
    expect(
      rebasePropertyEdit(
        {
          properties: { Venue: null, Conference: 'UIST' },
          propertyDisplayKeys: ['Conference', 'Year'],
        },
        base,
        server,
      ),
    ).toEqual({
      properties: { Venue: null, Conference: 'UIST' },
      propertyDisplayKeys: ['Year', 'Conference', 'Rating'],
    });
  });

  it('reorders only a display order the other save did not touch', () => {
    const reorder = { propertyDisplayKeys: ['Year', 'Venue'] };
    expect(
      rebasePropertyEdit(reorder, base, {
        properties: { Venue: 'DIS', Year: 2024 },
        propertyDisplayKeys: ['Venue', 'Year'],
      }),
    ).toEqual(reorder);
    expect(
      rebasePropertyEdit(reorder, base, {
        properties: { ...base.properties, Rating: 5 },
        propertyDisplayKeys: ['Venue', 'Year', 'Rating'],
      }),
    ).toBeNull();
  });

  it('reads a missing display order as the order of the property bag', () => {
    expect(
      rebasePropertyEdit(
        {
          properties: { Status: 'Read' },
          propertyDisplayKeys: ['Venue', 'Year', 'Status'],
        },
        { properties: base.properties },
        { properties: { ...base.properties, Rating: 5 } },
      ),
    ).toEqual({
      properties: { Status: 'Read' },
      propertyDisplayKeys: ['Venue', 'Year', 'Rating', 'Status'],
    });
  });
});
