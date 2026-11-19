// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PropertySymbol, type Window as HappyWindow } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import useCanvasStore from '@/store/canvasStore';

import { NotePreview } from './note/NotePreview';
import { OfficePreview } from './office/OfficePreview';
import { PreviewHeaderSlotContext } from './PreviewHeaderSlot';
import { VideoPreview } from './video/VideoPreview';
import { WebPreview } from './web/WebPreview';

import type * as NodeDownloadModule from '@/utils/io/nodeDownload';

const mocks = vi.hoisted(() => ({
  getWebPage: vi.fn(),
  getWebReader: vi.fn(),
  triggerMediaDownload: vi.fn(),
  triggerWebDownload: vi.fn(),
  triggerNoteDownload: vi.fn(),
}));

vi.mock('@/api/web', () => ({
  getWebPage: mocks.getWebPage,
  getWebReader: mocks.getWebReader,
}));

vi.mock('@/utils/io/nodeDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeDownloadModule>();
  return {
    ...actual,
    triggerMediaDownload: mocks.triggerMediaDownload,
    triggerWebDownload: mocks.triggerWebDownload,
    triggerNoteDownload: mocks.triggerNoteDownload,
  };
});

vi.mock('lottie-react', () => ({
  default: () => null,
}));
vi.mock('@/components/Milkdown', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
  MilkdownPreview: () => <div data-testid="milkdown-preview" />,
}));
vi.mock('@/components/Milkdown/MilkdownFloatingToolbar', () => ({
  MilkdownFloatingToolbar: () => null,
}));
vi.mock('./note/NoteCommentActions', () => ({
  NoteCommentActions: () => null,
}));
vi.mock('./note/ProvenanceOverlay', () => ({
  ProvenanceOverlay: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Preview header download actions', () => {
  let root: Root;
  let container: HTMLDivElement;
  let header: HTMLDivElement;

  beforeEach(() => {
    (document as unknown as { [PropertySymbol.window]: HappyWindow })[
      PropertySymbol.window
    ].happyDOM.settings.disableIframePageLoading = true;
    useCanvasStore.setState({ canvasId: 'canvas-1' });
    mocks.getWebPage.mockReset();
    mocks.getWebReader.mockReset().mockResolvedValue({ html: '' });
    mocks.triggerMediaDownload.mockReset();
    mocks.triggerWebDownload.mockReset();
    mocks.triggerNoteDownload.mockReset();

    container = document.createElement('div');
    header = document.createElement('div');
    document.body.append(container, header);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    header.remove();
    vi.restoreAllMocks();
  });

  it('exposes Note .md download in readOnly viewer mode and hides when contentMissing', () => {
    act(() => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <NotePreview
            id="note-1"
            readOnly
            data={{ label: '架构评审', content: '# Summary\n\nBody' }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });

    const downloadBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="Download"]',
    );
    expect(downloadBtn).not.toBeNull();
    act(() => downloadBtn?.click());
    expect(mocks.triggerNoteDownload).toHaveBeenCalledWith({
      content: '# Summary\n\nBody',
      label: '架构评审',
      missing: false,
    });

    act(() => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <NotePreview
            id="note-1"
            readOnly
            data={{ label: '架构评审', content: '', contentMissing: true }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });
    expect(header.querySelector('button[aria-label="Download"]')).toBeNull();
  });

  it('shows WebPreview download for remote URLs only when an MHTML snapshot exists, and hides for Interactive Views', async () => {
    mocks.getWebPage.mockResolvedValueOnce({
      kind: 'url',
      src: 'https://example.com',
      snapshot: false,
      embeddable: true,
    });

    await act(async () => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <WebPreview
            id="web-live"
            data={{ src: 'https://example.com', label: 'Live Site' }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });
    expect(header.querySelector('button[aria-label="Download"]')).toBeNull();

    mocks.getWebPage.mockResolvedValueOnce({
      kind: 'html',
      src: 'snap_abc.mhtml',
      snapshot: true,
      embeddable: true,
    });

    await act(async () => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <WebPreview
            id="web-snap"
            data={{ src: 'https://example.com/article', label: 'Article' }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });

    const snapBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="Download"]',
    );
    expect(snapBtn).not.toBeNull();
    act(() => snapBtn?.click());
    expect(mocks.triggerWebDownload).toHaveBeenCalledWith({
      src: 'https://example.com/article',
      mhtmlArtifact: 'snap_abc.mhtml',
      canvasId: 'canvas-1',
      label: 'Article',
      isInteractiveView: false,
      missing: false,
    });

    await act(async () => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <WebPreview
            id="web-app"
            data={{
              src: 'app_bundle.html',
              label: 'Calculator',
              interactiveView: { manifestVersion: 1 },
            }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });
    expect(header.querySelector('button[aria-label="Download"]')).toBeNull();
  });

  it('shows VideoPreview and OfficePreview download for stored artifacts while excluding external video URLs', () => {
    act(() => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <VideoPreview
            id="vid-1"
            data={{ src: 'https://youtu.be/dQw4w9WgXcQ', label: 'Talk' }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });
    expect(header.querySelector('button[aria-label="Download"]')).toBeNull();

    act(() => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <VideoPreview
            id="vid-2"
            data={{ src: 'clip_1.webm', label: 'Demo Recording' }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });
    const videoBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="Download"]',
    );
    expect(videoBtn).not.toBeNull();
    act(() => videoBtn?.click());
    expect(mocks.triggerMediaDownload).toHaveBeenCalledWith({
      src: 'clip_1.webm',
      canvasId: 'canvas-1',
      label: 'Demo Recording',
      defaultExt: '.mp4',
      fallbackStem: 'video',
      missing: false,
    });

    act(() => {
      root.render(
        <PreviewHeaderSlotContext.Provider value={{ el: header }}>
          <OfficePreview
            id="off-1"
            data={{
              src: 'deck_1.pptx',
              format: 'pptx',
              label: 'Q3 Review',
              content: '# Slide 1',
            }}
          />
        </PreviewHeaderSlotContext.Provider>,
      );
    });
    const officeBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="Download original file"]',
    );
    expect(officeBtn).not.toBeNull();
    act(() => officeBtn?.click());
    expect(mocks.triggerMediaDownload).toHaveBeenCalledWith({
      src: 'deck_1.pptx',
      canvasId: 'canvas-1',
      label: 'Q3 Review',
      defaultExt: '.pptx',
      fallbackStem: 'presentation',
      missing: false,
    });
  });
});
