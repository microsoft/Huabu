// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNodeAccent } from './design/nodeAccentPolicy';
import { nodeBoundaryForAccent } from './design/nodeBoundary';
import { frameRegionSurfaceStyle } from './frame/frameRegionStyle';
import { NodeWrapper } from './NodeWrapper';

const mocks = vi.hoisted(() => ({
  takeover: vi.fn(() => null),
  flow: {
    transform: [0, 0, 1],
    nodeLookup: new Map<string, { style: { width: number; height: number } }>(),
  },
  mode: 'overview',
  suppressed: false,
  canvas: {
    nodes: [] as { id: string; selected: boolean; dragging?: boolean }[],
    ingestionByNodeId: {},
    setNodeGeometry: vi.fn(),
    onNodeResizeStart: vi.fn(),
    updateResizePreview: vi.fn(),
    endResizePreview: vi.fn(),
  },
}));

vi.mock('@xyflow/react', () => ({
  useStore: (select: (state: typeof mocks.flow) => unknown) =>
    select(mocks.flow),
  NodeResizer: () => null,
}));
vi.mock('@/store/canvasStore.ts', () => ({
  default: (select: (state: typeof mocks.canvas) => unknown) =>
    select(mocks.canvas),
  clearNodeDuplicateGuard: vi.fn(),
}));
vi.mock('@/hooks/useNodePresentation', () => ({
  useNodePresentation: () => ({ mode: mocks.mode, zoom: 1 }),
}));
vi.mock('./frame/FrameZoomContext', () => ({
  useFrameSuppressed: () => mocks.suppressed,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useInputMode.ts', () => ({ useIsNotMouse: () => false }));
vi.mock('@/hooks/useMultiSelectModifier.ts', () => ({
  useMultiSelectModifierHeld: () => false,
}));
vi.mock('@/store/nodeCollapseStore.ts', () => ({
  useNodeCollapseStore: (
    select: (state: { marks: Record<string, never> }) => unknown,
  ) => select({ marks: {} }),
}));
vi.mock('@/store/gesturePreviewStore.ts', () => ({
  useGesturePreviewStore: (
    select: (state: {
      sketchStrokeSelection: Record<string, never>;
    }) => unknown,
  ) => select({ sketchStrokeSelection: {} }),
}));
vi.mock('@/store/connectPortStore.ts', () => ({
  useConnectPortStore: (select: (state: { pending: null }) => unknown) =>
    select({ pending: null }),
}));
vi.mock('@/handler/snap/snapSession.ts', () => ({}));
vi.mock('@/components/Common/Loading', () => ({ Loading: () => null }));
vi.mock(
  '@/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx',
  () => ({
    NodeFloatingToolbar: ({ dragEnabled }: { dragEnabled: boolean }) => (
      <div data-toolbar>{dragEnabled && <div data-node-drag-handle />}</div>
    ),
  }),
);
vi.mock('./NodeTakeoverLayer.tsx', () => ({
  NodeTakeoverLayer: mocks.takeover,
}));
vi.mock('./NodeConnectAffordance.tsx', () => ({
  NodeConnectionHandles: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('NodeWrapper radius contract', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    mocks.takeover.mockClear();
    mocks.mode = 'overview';
    mocks.suppressed = false;
    mocks.canvas.nodes = [];
    mocks.flow.transform = [0, 0, 1];
    mocks.flow.nodeLookup.set('node', { style: { width: 600, height: 600 } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(props: Partial<ComponentProps<typeof NodeWrapper>> = {}) {
    act(() =>
      root.render(
        <NodeWrapper
          id="node"
          type="image"
          data={{ type: 'image', src: '', label: 'Radius' }}
          resizable={false}
          {...props}
        >
          <div>Content</div>
        </NodeWrapper>,
      ),
    );
    const shell = container.querySelector<HTMLElement>('.semantic-lod-node');
    const content = container.querySelector<HTMLElement>(
      '.semantic-lod-content',
    );
    if (!shell || !content) throw new Error('Missing node shell');
    return { shell, content };
  }

  it.each([false, true])(
    'connects the mounted Question shell to takeover with Frame suppression %s',
    (suppressed) => {
      mocks.suppressed = suppressed;
      const renderMark = () => null;
      const { shell } = render({
        type: 'question',
        takeover: { renderMark, fontSize: 42, forceCollapsed: suppressed },
      });
      expect(mocks.takeover).toHaveBeenLastCalledWith(
        expect.objectContaining({
          nodeId: 'node',
          nodeRoot: shell,
          renderMark,
          fontSize: 42,
          forceCollapsed: suppressed,
          suppressed: false,
        }),
        undefined,
      );
    },
  );

  it.each([
    'image',
    'video',
    'audio',
    'office',
    'spacePreview',
    'note',
    'pdf',
    'web',
    'text',
    'question',
    'sketch',
  ] as const)('defaults %s to the shared responsive shell', (type) => {
    for (const [size, radius] of [
      [400, 12],
      [600, 18],
      [900, 24],
    ]) {
      mocks.flow.nodeLookup.set('node', {
        style: { width: size, height: size },
      });
      const { shell, content } = render({ type });
      const inner =
        radius -
        (type === 'image' || type === 'video' || type === 'sketch' ? 0 : 3);
      expect(shell.style.borderRadius).toBe(`${radius}px`);
      expect(content.style.borderRadius).toBe(`${inner}px`);
      expect(content.style.getPropertyValue('--node-inner-radius')).toBe(
        `${inner}px`,
      );
      expect(content.classList.contains('overflow-hidden')).toBe(true);
      const placeholder = shell.querySelector<HTMLElement>(
        '.semantic-lod-placeholder',
      );
      if (placeholder)
        expect(placeholder.style.borderRadius).toBe(`${inner}px`);
    }
  });

  it.each([
    'video',
    'pdf',
    'web',
    'image',
    'audio',
    'office',
    'spacePreview',
    'frame',
    'note',
    'text',
    'question',
    'sketch',
  ] as const)(
    'composes the %s type drag surface in the toolbar, never in the shell',
    (type) => {
      mocks.canvas.nodes = [{ id: 'node', selected: true }];
      const props = { type, selected: true };
      const { shell, content } = render(props);
      const grip = container.querySelector<HTMLElement>(
        '[data-node-drag-handle]',
      );
      expect(grip).not.toBeNull();
      expect(grip?.parentElement?.hasAttribute('data-toolbar')).toBe(true);
      expect(shell.contains(grip)).toBe(false);
      expect(content.contains(grip)).toBe(false);
      mocks.canvas.nodes[0].dragging = true;
      render(props);
      expect(container.querySelector('[data-toolbar]')).toBeNull();
    },
  );

  it.each(['video', 'pdf', 'web'] as const)(
    'retains %s toolbar mount gates and rejects locked dragging',
    (type) => {
      const props = { type, selected: true };
      const absent = (
        extra: Partial<ComponentProps<typeof NodeWrapper>> = {},
      ) => {
        render({ ...props, data: { type, src: 'source' }, ...extra });
        expect(container.querySelector('[data-node-drag-handle]')).toBeNull();
      };
      mocks.canvas.nodes = [{ id: 'node', selected: true }];
      absent({ selected: false });
      absent({ data: { type, src: 'source', locked: true } });
      expect(container.querySelector('[data-toolbar]')).not.toBeNull();
      mocks.suppressed = true;
      absent();
      mocks.suppressed = false;
      mocks.canvas.nodes = [
        ...mocks.canvas.nodes,
        { id: 'other', selected: true },
      ];
      absent();
      mocks.canvas.nodes = [];
      absent();
    },
  );

  it.each([
    'video',
    'pdf',
    'web',
    'image',
    'audio',
    'office',
    'spacePreview',
    'frame',
    'note',
    'text',
    'question',
    'sketch',
  ] as const)(
    'allows %s toolbar dragging regardless of source, content or presentation',
    (type) => {
      mocks.canvas.nodes = [{ id: 'node', selected: true }];
      for (const mode of ['minimal', 'overview', 'reading']) {
        mocks.mode = mode;
        for (const extra of [
          {},
          { contentDuplicate: true },
          { contentMissing: true },
          { artifactMissing: true },
        ]) {
          render({
            type,
            selected: true,
            data: { type, src: '', ...extra } as ComponentProps<
              typeof NodeWrapper
            >['data'],
          });
          expect(
            container.querySelector('[data-node-drag-handle]'),
          ).not.toBeNull();
        }
      }
    },
  );

  it.each(['image', 'video', 'note', 'pdf', 'web'] as const)(
    'honors custom and square %s corners',
    (type) => {
      for (const radius of [31, 0]) {
        const { shell, content } = render({ type, borderRadius: radius });
        expect(shell.style.borderRadius).toBe(`${radius}px`);
        expect(content.style.borderRadius).toBe(
          `${Math.max(0, radius - (type === 'image' || type === 'video' ? 0 : 3))}px`,
        );
      }
    },
  );

  it.each(['image', 'video'] as const)(
    'paints the %s boundary without a layout inset in selected and unselected states',
    (type) => {
      for (const selected of [false, true]) {
        mocks.canvas.nodes = [{ id: 'node', selected }];
        const { shell, content } = render({
          type,
          selected,
          data: { type, src: '', style: { accent: 'teal' } },
        });
        const border = shell.querySelector<HTMLElement>(
          '[data-node-media-border]',
        );
        expect(shell.classList.contains('border-3')).toBe(false);
        expect(content.classList.contains('p-0')).toBe(true);
        expect(content.style.borderRadius).toBe(shell.style.borderRadius);
        expect(border?.parentElement).toBe(shell);
        expect(border?.getAttribute('aria-hidden')).toBe('true');
        for (const name of [
          'absolute',
          'inset-0',
          'pointer-events-none',
          'border-3',
          'border-[inherit]',
          'rounded-[inherit]',
          'z-1',
        ])
          expect(border?.classList.contains(name)).toBe(true);
        expect(border?.hasAttribute('data-node-image-border')).toBe(
          type === 'image',
        );
      }
    },
  );

  it.each([
    'image',
    'video',
    'audio',
    'office',
    'spacePreview',
    'note',
    'pdf',
    'web',
  ] as const)(
    'shares the Note boundary color for %s in every presentation',
    (type) => {
      // Happy DOM drops color-mix border values; assert the assigned CSS here
      // and verify computed colors and overlay inheritance in Chromium.
      const borderColor = vi.spyOn(
        CSSStyleDeclaration.prototype,
        'borderColor',
        'set',
      );
      for (const accent of ['teal', 'white', '#008080', undefined]) {
        const resolved = resolveNodeAccent(type, accent);
        const boundary = {
          ...nodeBoundaryForAccent(resolved),
          ...((type === 'image' || type === 'video') &&
            !resolved && { borderColor: 'transparent' }),
        };
        for (const mode of ['overview', 'minimal', 'reading']) {
          mocks.mode = mode;
          for (const suppressed of [false, true]) {
            mocks.suppressed = suppressed;
            const { shell } = render({
              type,
              data: { type, style: { accent } } as ComponentProps<
                typeof NodeWrapper
              >['data'],
            });
            expect(borderColor).toHaveBeenLastCalledWith(
              (type === 'pdf' || type === 'web') && mode === 'reading'
                ? 'transparent'
                : suppressed
                  ? frameRegionSurfaceStyle(resolved, boundary.borderColor)
                      .borderColor
                  : boundary.borderColor,
            );
            expect(shell.style.borderWidth).toBe(
              (type === 'pdf' || type === 'web') && mode === 'reading'
                ? '0px'
                : type === 'image' || type === 'video'
                  ? '0px'
                  : '3px',
            );
          }
        }
      }
    },
  );

  it.each(['pdf', 'web'] as const)(
    'removes %s card chrome while reading and restores it in overview',
    (type) => {
      mocks.mode = 'reading';
      const { shell: reading } = render({ type });
      expect(reading.style.backgroundColor).toBe('transparent');
      expect(reading.style.borderColor).toBe('transparent');
      expect(reading.style.borderWidth).toBe('0px');
      expect(reading.classList.contains('hover:shadow-sm')).toBe(false);

      mocks.mode = 'overview';
      const { shell: overview } = render({ type });
      expect(
        overview.style.getPropertyValue('--note-surface-background'),
      ).toContain('color-mix(');
      expect(overview.style.borderWidth).toBe('3px');
      expect(overview.classList.contains('hover:shadow-sm')).toBe(true);
    },
  );

  it('keeps Question borders transparent and Sketch without a layout border', () => {
    const data = { type: 'image' as const, style: { accent: 'teal' }, src: '' };
    expect(render({ type: 'question', data }).shell.style.borderColor).toBe(
      'transparent',
    );
    const { shell } = render({ type: 'sketch', data });
    expect(shell.style.borderWidth).toBe('');
    expect(shell.classList.contains('border-3')).toBe(false);
  });

  it('preserves Frame surface defaults and overrides', () => {
    expect(
      render({ type: 'frame', allowOverflow: true }).shell.style.borderRadius,
    ).toBe('24px');
    const { shell, content } = render({
      type: 'frame',
      borderRadius: 32,
      allowOverflow: true,
    });
    expect(shell.style.borderRadius).toBe('32px');
    expect(content.classList.contains('overflow-visible')).toBe(true);
  });

  it('shares the Note tint with Text without painting its reserved border inset', () => {
    const { shell: note } = render({
      type: 'note',
      data: { type: 'note', content: '', style: { accent: 'teal' } },
    });
    const tint = note.style.getPropertyValue('--note-surface-background');
    expect(tint).toContain('color-mix(');
    const { shell } = render({
      type: 'text',
      data: { type: 'text', content: 'Label', style: { accent: 'teal' } },
    });
    expect(shell.style.getPropertyValue('--note-surface-background')).toBe(
      tint,
    );
    expect(shell.style.borderColor).toBe('');
    expect(shell.classList.contains('border-transparent')).toBe(true);
    expect(shell.classList.contains('border-3')).toBe(true);
    expect(shell.classList.contains('hover:ring')).toBe(false);
    expect(shell.classList.contains('hover:shadow-sm')).toBe(false);
  });

  it('clears the Text tint when its accent is removed', () => {
    render({
      type: 'text',
      data: { type: 'text', content: 'Label', style: { accent: 'teal' } },
    });
    const { shell } = render({
      type: 'text',
      data: { type: 'text', content: 'Label', style: {} },
    });
    expect(shell.style.getPropertyValue('--note-surface-background')).toBe('');
    expect(shell.style.backgroundColor).toBe('');
    expect(shell.style.borderColor).toBe('');
    expect(shell.classList.contains('bg-transparent')).toBe(true);
    expect(shell.classList.contains('border-transparent')).toBe(true);
  });

  it.each(['question', 'sketch'] as const)(
    'does not clip overflowing %s content',
    (type) => {
      const { content } = render({ type, allowOverflow: true });
      expect(content.classList.contains('overflow-visible')).toBe(true);
      expect(content.classList.contains('overflow-hidden')).toBe(false);
    },
  );
});
