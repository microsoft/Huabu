// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ACCENT_PALETTE, resolveAccent, type AccentToken } from '@huabu/shared';

import { ColorPicker } from '@/components/Common/ColorPicker';
import { MilkdownPreview } from '@/components/Milkdown/MilkdownPreview';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { readNoteIntrinsicHeight } from '@/components/Nodes/note/noteContentHost';
import { NoteContentViewport } from '@/components/Nodes/note/NoteContentViewport';
import {
  noteBoundaryForAccent,
  noteSurfaceStyle,
} from '@/components/Nodes/note/noteDesign';
import { containNoteWheel } from '@/components/Nodes/note/noteScroll';
import { NoteTruncationOverlay } from '@/components/Nodes/note/NoteTruncationOverlay';

const NOTE_FIXTURES = [
  { label: 'Compact', width: 352, height: 280 },
  { label: 'Regular', width: 640, height: 480 },
  { label: 'Large', width: 960, height: 800 },
] as const;

export const NOTE_EXCERPT =
  '基于原生终端渲染能力构建的 macOS 工作区，将多个会话、任务和 Agent 集中在同一空间。';

const NOTE_MARKDOWN = `# cmux：原生终端工作区

**定位：** ${NOTE_EXCERPT}

## 关键能力

- 并行会话：在不同任务之间切换，保留各自的上下文。
- 可恢复工作区：重新打开后继续之前的工作。
- 结构化导航：让长期任务和临时探索都有明确的位置。

## 设计判断

内容是主角；容器只提供层级、边界和轻量的颜色识别。阅读时可以滚动文档，而不改变卡片本身的尺寸。

> 将正在处理的资料和阶段性结论放在一起，减少来回寻找上下文的成本。

## 工作记录

1. 整理当前任务需要的资料，保留原始链接和关键说明。
2. 对照多个会话中的结果，记录需要进一步验证的问题。
3. 汇总已经确认的结论，将后续行动留在文档中。

### 后续检查

检查会话恢复后是否保留任务上下文，并确认不同窗口之间的导航是否清晰。

记录仍未解决的问题，下一次打开工作区时从这里继续。
`;

/** Observe local DOM only; specimens must never write canvas measurements. */
function useNoteSpecimenViewport() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentHostRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener('wheel', containNoteWheel, {
      capture: true,
      passive: true,
    });
    return () =>
      viewport.removeEventListener('wheel', containNoteWheel, {
        capture: true,
      });
  }, []);

  useEffect(() => {
    const host = contentHostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport) return;

    const measure = () => {
      setContentHeight(readNoteIntrinsicHeight(host));
      setViewportHeight(viewport.clientHeight);
    };
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(host);
    resizeObserver.observe(viewport);
    let observedProse: Element | null = null;
    const syncContent = () => {
      const prose = host.querySelector('.ProseMirror');
      if (prose !== observedProse) {
        if (observedProse) resizeObserver.unobserve(observedProse);
        observedProse = prose;
        if (prose) resizeObserver.observe(prose);
      }
      measure();
    };
    const mutationObserver = new MutationObserver(syncContent);
    mutationObserver.observe(host, { childList: true, subtree: true });
    syncContent();
    const frame = requestAnimationFrame(syncContent);
    return () => {
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  return {
    viewportRef,
    contentHostRef,
    onScroll: (event: React.UIEvent<HTMLDivElement>) =>
      setScrollTop(event.currentTarget.scrollTop),
    showFade:
      contentHeight > 0 &&
      viewportHeight > 0 &&
      contentHeight - viewportHeight - scrollTop > 1,
  };
}

export function NoteSpecimen({
  label,
  width,
  height,
  accent,
  zoom,
  showCaption = true,
  title,
}: {
  label: string;
  width: number;
  height: number;
  accent: AccentToken;
  zoom?: number;
  showCaption?: boolean;
  title?: string;
}) {
  const { showFade, ...viewport } = useNoteSpecimenViewport();
  const presentationScale = zoom ?? Math.min(1, 300 / width, 260 / height);
  const resolvedAccent = resolveAccent(accent);
  const metrics = nodeMetricsForSize(width, height);

  return (
    <section
      className="flex shrink-0 flex-col items-center gap-3"
      aria-label={`${label} Note`}
    >
      {showCaption && (
        <div className="text-center">
          <h3 className="text-fg-default text-sm font-medium">{label}</h3>
          <p className="text-fg-subtle text-xs">
            {width} × {height} · {metrics.tier} · Scroll enabled
          </p>
        </div>
      )}
      <div
        className="relative shrink-0"
        data-note-presentation=""
        style={{
          width: width * presentationScale,
          height: height * presentationScale,
        }}
      >
        <article
          aria-label={`${label} read-only specimen`}
          data-note-specimen={label}
          data-note-size={metrics.tier}
          className="huabu-note-surface absolute top-0 left-0 box-border overflow-hidden border-solid"
          style={{
            width,
            height,
            transform: `scale(${presentationScale})`,
            transformOrigin: 'top left',
            borderRadius: metrics.radius,
            ...noteBoundaryForAccent(resolvedAccent),
            ...noteSurfaceStyle(resolvedAccent),
          }}
        >
          {/* The border-box shell leaves the same inner dimensions as NodeWrapper. */}
          <div className="relative h-full w-full overflow-hidden">
            <NoteContentViewport {...viewport} scrollingEnabled>
              <MilkdownPreview
                markdown={
                  title
                    ? NOTE_MARKDOWN.replace(
                        '# cmux：原生终端工作区',
                        `# ${title}`,
                      )
                    : NOTE_MARKDOWN
                }
                ariaLabel={`${label} Note content`}
                className="pointer-events-none w-full select-none"
              />
            </NoteContentViewport>
            {showFade && (
              <NoteTruncationOverlay
                counterZoomScale={Math.min(
                  3,
                  Math.max(1, 1 / presentationScale),
                )}
              />
            )}
          </div>
        </article>
      </div>
    </section>
  );
}

export function NoteDesignDraft() {
  const [accent, setAccent] = useState<AccentToken>('teal');

  return (
    <div className="flex flex-col gap-5">
      <p className="text-fg-muted text-sm">
        Read-only, scroll-enabled specimens using the current production Note
        layout: fixed canvas-unit typography and padding, with reflow on width
        changes and scaling only from viewport zoom. These are not canvas
        selections. On the canvas, scrolling requires a sole-selected,
        full-detail, fixed-height Note with available content.
      </p>
      <div className="bg-bg-default overflow-x-auto rounded-lg p-6">
        <div className="flex w-max min-w-full items-start justify-center gap-6">
          {NOTE_FIXTURES.map((fixture) => (
            <NoteSpecimen key={fixture.label} {...fixture} accent={accent} />
          ))}
        </div>
      </div>
      <div>
        <div className="text-fg-muted mb-2 text-xs font-medium">Accent</div>
        <ColorPicker
          colors={ACCENT_PALETTE}
          activeToken={accent}
          onSelect={(token) => {
            const option = ACCENT_PALETTE.find(
              (entry) => entry.token === token,
            );
            if (option) setAccent(option.token);
          }}
        />
      </div>
    </div>
  );
}
