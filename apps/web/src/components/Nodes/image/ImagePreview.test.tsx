// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PreviewHeaderSlotContext } from '../PreviewHeaderSlot';
import { ImagePreview } from './ImagePreview';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('<ImagePreview>', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let header: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    header?.remove();
    root = undefined;
    container = undefined;
    header = undefined;
  });

  it('renders image content actions in the expanded preview header', () => {
    container = document.createElement('div');
    header = document.createElement('div');
    document.body.append(container, header);
    root = createRoot(container);

    act(() => {
      root?.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header ?? null }}>
          <ImagePreview
            data={{ src: 'artifact-image.png', label: 'Diagram' }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });

    expect(
      header.querySelector('button[aria-label="Copy image"]'),
    ).not.toBeNull();
    expect(
      header.querySelector('button[aria-label="Download image"]'),
    ).not.toBeNull();
  });
});
