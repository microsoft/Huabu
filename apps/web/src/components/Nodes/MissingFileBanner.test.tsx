// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { getMissingFileKind, MissingFileBanner } from './MissingFileBanner';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('<MissingFileBanner>', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('owns both responsive layouts instead of requiring a node-specific variant', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      const mountedRoot = root;
      if (!mountedRoot) throw new Error('Missing React root');
      mountedRoot.render(<MissingFileBanner nodeId="missing-node" />);
    });

    const banner = container.querySelector<HTMLElement>('.missing-file-banner');
    expect(banner?.style.containerType).toBe('size');
    expect(
      banner?.querySelector('.missing-file-banner__compact'),
    ).not.toBeNull();
    expect(banner?.querySelector('.missing-file-banner__full')).not.toBeNull();
  });
});

describe('getMissingFileKind', () => {
  it('returns null when no backing file is missing', () => {
    expect(getMissingFileKind({})).toBeNull();
  });

  it('ignores non-boolean truthy flag values', () => {
    expect(getMissingFileKind({ contentMissing: 'true' })).toBeNull();
    expect(getMissingFileKind({ artifactMissing: 1 })).toBeNull();
  });

  it('distinguishes artifact loss from sidecar loss', () => {
    expect(getMissingFileKind({ artifactMissing: true })).toBe('artifact');
    expect(getMissingFileKind({ contentMissing: true })).toBe('sidecar');
  });

  it('prioritizes sidecar loss when both files are missing', () => {
    expect(
      getMissingFileKind({ contentMissing: true, artifactMissing: true }),
    ).toBe('sidecar');
  });
});
