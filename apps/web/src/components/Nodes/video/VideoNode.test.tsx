// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoNode, type VideoNodeType } from './VideoNode';
import { VideoPreview } from './VideoPreview';

import type { NodeProps } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  presentation: {
    mode: 'overview',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  },
  previewOpen: false,
  frameSuppressed: false,
  selectNodes: vi.fn(),
}));
vi.mock('@/hooks/useNodePresentation', () => ({
  useNodePresentation: () => mocks.presentation,
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (state: unknown) => unknown) =>
    select({
      canvasId: 'canvas-1',
      nodes: [{ id: 'video', selected: mocks.presentation.isSoleSelected }],
      selectNodes: mocks.selectNodes,
    }),
}));
vi.mock('@/api/artifact', () => ({
  resolveArtifactUrl: (src: string) => `resolved:${src}`,
}));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewNode: vi.fn(),
}));
vi.mock('@/store/previewWorkspace/store', () => ({
  usePreviewWorkspaceStore: (select: (state: unknown) => unknown) =>
    select({ canvasId: 'canvas-1' }),
  selectIsNodeOpen: () => mocks.previewOpen,
}));
vi.mock('../frame/FrameZoomContext', () => ({
  useFrameSuppressed: () => mocks.frameSuppressed,
}));
vi.mock('../NodeWrapper', () => ({
  NodeWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../Common/FloatingToolbar', () => ({
  FloatingToolbar: { ActionButton: () => null },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const data = {
  type: 'video' as const,
  src: 'movie.webm',
  label: 'Movie',
  coverUrl: 'poster.jpg',
  coverSourceSrc: 'movie.webm',
};

beforeEach(() => {
  mocks.presentation = {
    mode: 'overview',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  };
  mocks.previewOpen = false;
  mocks.frameSuppressed = false;
  mocks.selectNodes.mockReset().mockImplementation(() => {
    mocks.presentation.isSoleSelected = true;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
function render(extra: Record<string, unknown> = {}) {
  const props: NodeProps<VideoNodeType> = {
    id: 'video',
    type: 'video',
    data: { ...data, ...extra },
    selected: mocks.presentation.isSoleSelected,
    draggable: true,
    selectable: true,
    deletable: true,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  act(() => root.render(<VideoNode {...props} />));
}

function requireVideo() {
  const video = container.querySelector('video');
  if (!video) throw new Error('Expected mounted native video');
  return video;
}

function play() {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="node.playVideo"]',
  );
  if (!button) throw new Error('Missing play button');
  act(() => button.click());
}

describe('VideoNode', () => {
  it.each([0.5, 1, 2])(
    'shows one Play glyph without a layered placeholder at zoom %s',
    (zoom) => {
      mocks.presentation.zoom = zoom;
      render({ coverUrl: undefined });
      expect(container.querySelectorAll('svg')).toHaveLength(1);
      expect(container.querySelector('button svg.lucide-play')).not.toBeNull();
      expect(container.querySelector('[data-video-player] svg')).toBeNull();
      const playButton = container.querySelector('button');
      expect(playButton?.parentElement?.style.transform).toBe('');
      expect(playButton?.classList.contains('h-12')).toBe(true);
      expect(playButton?.classList.contains('w-12')).toBe(true);
      mocks.presentation.mode = 'minimal';
      render({ coverUrl: undefined });
      expect(container.querySelector('button')).toBeNull();
      expect(
        container.querySelector('[data-video-player] svg.lucide-film'),
      ).not.toBeNull();
      expect(container.querySelector('svg')?.getAttribute('width')).toBe('48');
      expect(container.querySelector('svg.lucide-video')).toBeNull();
      render({ src: '', coverUrl: undefined });
      expect(container.textContent).toContain('node.noVideoSource');
    },
  );
  it('keeps the standalone missing-source preview fallback', () => {
    act(() =>
      root.render(<VideoPreview id="video" data={{ ...data, src: '' }} />),
    );
    expect(container.querySelector('svg.lucide-film')).not.toBeNull();
    expect(container.textContent).toContain('node.noVideoSource');
  });
  it('loads only the matched poster while unselected and at far zoom', () => {
    render();
    expect(container.querySelector('video, iframe')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'resolved:poster.jpg',
    );
    mocks.presentation.mode = 'minimal';
    mocks.presentation.isSoleSelected = true;
    render();
    expect(container.querySelector('video, iframe')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });
  it('exposes native unmuted, non-autoplay controls in overview with a screen-sized viewport', () => {
    mocks.presentation.isSoleSelected = true;
    mocks.presentation.zoom = 0.5;
    render();
    play();
    const video = requireVideo();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.getAttribute('poster')).toBe('resolved:poster.jpg');
    const surface = container.querySelector<HTMLElement>(
      '[data-video-controls]',
    );
    if (!surface) throw new Error('Missing video surface');
    expect(surface.style.transform).toBe('scale(2)');
    expect(surface.style.width).toBe('50%');
    expect(surface.classList.contains('nowheel')).toBe(true);
    mocks.presentation.zoom = 0.7;
    render();
    expect(container.querySelector('video')).toBe(video);
  });
  it.each([
    'deselect',
    'multi-select',
    'offscreen',
    'far',
    'preview',
    'frame',
    'missing',
  ])(
    'pauses and removes the native player on %s without auto-resuming',
    (reason) => {
      mocks.presentation.isSoleSelected = true;
      render();
      play();
      const video = requireVideo();
      const pause = vi.spyOn(video, 'pause');
      if (reason === 'deselect' || reason === 'multi-select')
        mocks.presentation.isSoleSelected = false;
      if (reason === 'offscreen') mocks.presentation.isVisible = false;
      if (reason === 'far') mocks.presentation.mode = 'minimal';
      if (reason === 'preview') mocks.previewOpen = true;
      if (reason === 'frame') mocks.frameSuppressed = true;
      render(reason === 'missing' ? { artifactMissing: true } : {});
      expect(pause).toHaveBeenCalledOnce();
      expect(container.querySelector('video')).toBeNull();
      mocks.presentation.isSoleSelected = true;
      mocks.presentation.isVisible = true;
      mocks.presentation.mode = 'overview';
      mocks.previewOpen = false;
      mocks.frameSuppressed = false;
      render();
      expect(container.querySelector('video')).toBeNull();
    },
  );
  it('rejects stale covers and pauses the old source during replacement', () => {
    mocks.presentation.isSoleSelected = true;
    render();
    play();
    const video = requireVideo();
    const pause = vi.spyOn(video, 'pause');
    render({ src: 'new.webm' });
    expect(pause).toHaveBeenCalledOnce();
    expect(container.querySelector('video, img')).toBeNull();
    play();
    expect(requireVideo().hasAttribute('poster')).toBe(false);
  });
  it('uses an allowlisted YouTube embed only when active and removes it on far zoom', () => {
    // Inspect iframe lifecycle without connecting it to a remote browsing context.
    container.remove();
    const src = 'https://youtu.be/dQw4w9WgXcQ';
    render({ src });
    expect(container.querySelector('iframe')).toBeNull();
    mocks.presentation.isSoleSelected = true;
    render({ src });
    expect(container.querySelector('iframe')).toBeNull();
    play();
    expect(container.querySelector('iframe')?.src).toContain(
      'youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1',
    );
    expect(container.querySelector('iframe')?.allow).toContain('autoplay');
    mocks.presentation.mode = 'minimal';
    render({ src });
    expect(container.querySelector('iframe')).toBeNull();
  });
  it('expanded preview shares poster validation and does not autoplay', () => {
    act(() => root.render(<VideoPreview id="video" data={data} />));
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(
      'resolved:poster.jpg',
    );
    expect(container.querySelector('video')?.autoplay).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    act(() =>
      root.render(
        <VideoPreview
          id="video"
          data={{ ...data, coverSourceSrc: 'old.webm' }}
        />,
      ),
    );
    expect(container.querySelector('video')?.hasAttribute('poster')).toBe(
      false,
    );
  });
  it('selects an unselected node and plays once without losing intent to mirrored selection', () => {
    render();
    play();
    expect(mocks.selectNodes).toHaveBeenCalledWith(['video']);
    expect(requireVideo().play).toHaveBeenCalledOnce();
  });
  it('keeps poster input bubbling while isolating button input', () => {
    const bubbled = vi.fn();
    document.body.addEventListener('pointerdown', bubbled);
    render();
    container
      .querySelector('[data-video-play-overlay]')
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bubbled).toHaveBeenCalledOnce();
    container
      .querySelector('button')
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bubbled).toHaveBeenCalledOnce();
    document.body.removeEventListener('pointerdown', bubbled);
  });
  it('handles rejected playback with a localized retry instead of an unhandled rejection', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new Error('Blocked'),
    );
    render();
    await act(async () => play());
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'node.videoPlaybackFailed',
    );
    play();
    expect(requireVideo()).toBeTruthy();
  });
});
