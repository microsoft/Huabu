// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import {
  readEdgeTagsEnabled,
  useEdgeTagsEnabled,
  writeEdgeTagsEnabled,
} from './edgeTagPreference';

afterEach(() => localStorage.clear());

it('shows the tags until the person turns them off, and stores only "off"', () => {
  expect(readEdgeTagsEnabled()).toBe(true);
  writeEdgeTagsEnabled(false);
  expect(localStorage.getItem('huabu.showEdgeTags')).toBe('false');
  expect(readEdgeTagsEnabled()).toBe(false);
  writeEdgeTagsEnabled(true);
  expect(localStorage.getItem('huabu.showEdgeTags')).toBeNull();
});

it('follows a change made on this page and one made on another', () => {
  const result = { current: false };
  const Probe = () => {
    result.current = useEdgeTagsEnabled();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  expect(result.current).toBe(true);
  act(() => writeEdgeTagsEnabled(false));
  expect(result.current).toBe(false);
  act(() => {
    localStorage.removeItem('huabu.showEdgeTags');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'huabu.showEdgeTags' }),
    );
  });
  expect(result.current).toBe(true);
  act(() => root.unmount());
});
