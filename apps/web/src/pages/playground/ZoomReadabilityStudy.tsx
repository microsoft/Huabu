// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { resolveAccent } from '@huabu/shared';
import { resolveFrameResponsiveLayout } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { RangeSlider } from '@/components/Common/RangeSlider';
import { nodeBoundaryForAccent } from '@/components/Nodes/design/nodeBoundary';
import { frameVisualMetricsForSize } from '@/components/Nodes/frame/frameDesign';
import { FrameHeader } from '@/components/Nodes/frame/FrameHeader';
import { getFrameHeaderMetrics } from '@/components/Nodes/frame/frameHeaderMetrics';
import { FrameRegionLabel } from '@/components/Nodes/frame/FrameRegionLabel';
import { frameRegionSurfaceStyle } from '@/components/Nodes/frame/frameRegionStyle';
import { FrameSurface } from '@/components/Nodes/frame/FrameSurface';
import { noteSurfaceStyle } from '@/components/Nodes/note/noteDesign';
import { PreviewCard } from '@/components/Nodes/previewCard/PreviewCard';
import { previewCardMetricsForSize } from '@/components/Nodes/previewCard/previewCardDesign';
import { FarZoomLabel } from '@/components/Nodes/semanticZoom/FarZoomLabel';

import overviewCover from './assets/overview-cover.png';
import { FarLabelTypographyComparison } from './FarLabelTypographyComparison';
import {
  farFramePresentation,
  farFrameRegionPresentation,
  farNodePresentation,
  type FarNodeState,
} from './farZoomPresentation';
import { NOTE_EXCERPT, NoteSpecimen } from './NoteDesignDraft';

import type { ReactNode } from 'react';

const NODE = { width: 400, height: 320 };
const DENSE_NODE = { width: 240, height: 180 };
const FRAME_GAP = 80;
const SCENE = { width: 1400, height: 550 };
const PRESETS = [100, 50, 35, 25, 15, 14, 10, 8, 5] as const;
type Variant = 'baseline' | 'proposal';
type Context = 'independent' | 'grouped' | 'dense' | 'tall';
const ACCENT = resolveAccent('teal');
const MEDIA = [
  {
    type: 'web',
    title: 'Huabu：视觉研究工作区',
    source: 'example.org',
    summary:
      '在画布中连接资料、笔记与 Agent，保留来源与讨论上下文，整理可以追踪的研究结论。',
    image: overviewCover,
  },
  {
    type: 'pdf',
    title: '生成式界面：收益与评估边界',
    source: 'PDF',
    summary:
      '结合任务完成率、修改成本和长期使用反馈，判断生成式界面是否真正帮助用户完成工作。',
  },
] as const;

/** Size the fixture grid with the same self-consistent tiers as Hug Frames. */
function studyFrameLayout(dense: boolean) {
  const node = dense ? DENSE_NODE : NODE;
  const rows = dense ? 2 : 1;
  return resolveFrameResponsiveLayout((metrics) => ({
    metrics,
    frameSize: {
      width: node.width * 3 + metrics.contentSpacing * 4,
      height:
        node.height * rows +
        metrics.contentSpacing * rows +
        metrics.headerInset,
    },
  }));
}

const GROUPED_FRAME = studyFrameLayout(false);
const DENSE_FRAME = studyFrameLayout(true);

function StudyNode({
  type,
  width,
  height,
  zoom,
  variant,
  frameOverview = false,
  shortTitle = false,
}: {
  type: 'note' | 'web' | 'pdf';
  width: number;
  height: number;
  zoom: number;
  variant: Variant;
  frameOverview?: boolean;
  shortTitle?: boolean;
}) {
  const metrics = previewCardMetricsForSize(width, height);
  const item = MEDIA.find((media) => media.type === type);
  const title = shortTitle
    ? type === 'note'
      ? 'cmux'
      : type === 'web'
        ? 'Huabu'
        : '评估边界'
    : (item?.title ?? 'cmux：原生终端工作区');
  const description = type === 'note' ? NOTE_EXCERPT : item?.summary;
  const [previous, setPrevious] = useState<FarNodeState>();
  const presentation = farNodePresentation(
    width * zoom,
    height * zoom,
    zoom,
    0,
    previous,
    nodeBoundaryForAccent(ACCENT).borderWidth * zoom,
  );
  // Update only this component before commit; never paint an intermediate fade.
  if (
    previous?.contentOpacity !== presentation.contentOpacity ||
    previous?.labelRetained !== presentation.labelRetained
  ) {
    setPrevious({
      contentOpacity: presentation.contentOpacity,
      labelRetained: presentation.labelRetained,
    });
  }
  const proposed = variant === 'proposal';
  const contentOpacity = proposed
    ? frameOverview
      ? 0
      : type === 'note'
        ? presentation.contentOpacity
        : 1
    : 1;
  const labelOpacity =
    proposed && !frameOverview ? presentation.labelOpacity : 0;
  return (
    <article
      data-study-node={type}
      className="relative box-border shrink-0 overflow-hidden border-solid"
      style={{
        width,
        height,
        opacity: 1,
        ...nodeBoundaryForAccent(ACCENT),
        borderRadius: metrics.radius,
        ...(type === 'note'
          ? noteSurfaceStyle(ACCENT)
          : { backgroundColor: 'var(--bg-surface)' }),
        ...(proposed &&
          frameOverview &&
          frameRegionSurfaceStyle(
            ACCENT,
            nodeBoundaryForAccent(ACCENT).borderColor,
          )),
      }}
      aria-label={title}
    >
      <div
        data-study-content=""
        aria-hidden={contentOpacity === 0}
        inert={contentOpacity < 1}
        style={{ opacity: contentOpacity, height: '100%' }}
      >
        {type === 'note' ? (
          // Reuse the complete Note specimen without adding a second visible shell.
          <div
            className="absolute"
            style={{ inset: -nodeBoundaryForAccent(ACCENT).borderWidth }}
          >
            <NoteSpecimen
              label="Zoom reference"
              width={width}
              height={height}
              accent="teal"
              zoom={1}
              showCaption={false}
              title={title}
            />
          </div>
        ) : item ? (
          <PreviewCard
            width={width}
            height={height}
            accent={ACCENT}
            farZoom={
              proposed && presentation.contentOpacity === 0 ? zoom : undefined
            }
            nodeType={item.type}
            title={title}
            source={item.source}
            summary={item.summary}
            image={'image' in item ? item.image : undefined}
            imageAlt="Illustrative cover, not a captured webpage"
          />
        ) : null}
      </div>
      {proposed && type === 'note' && (
        <FarZoomLabel
          title={title}
          description={description}
          zoom={zoom}
          visible={labelOpacity === 1}
          lines={presentation.lines}
          verticalInset={presentation.verticalInset}
          horizontalInset={presentation.horizontalInset}
          width={presentation.availableWidth}
          height={presentation.availableHeight}
        />
      )}
    </article>
  );
}

function StudyNodes({
  zoom,
  variant,
  dense = false,
  frameOverview = false,
  tall = false,
  left = 60,
  top = 220,
  gap = dense ? 24 : 40,
}: {
  zoom: number;
  variant: Variant;
  dense?: boolean;
  frameOverview?: boolean;
  tall?: boolean;
  left?: number;
  top?: number;
  gap?: number;
}) {
  const types = dense
    ? (['note', 'web', 'pdf', 'pdf', 'note', 'web'] as const)
    : (['note', 'web', 'pdf'] as const);
  const size = tall ? { width: 400, height: 700 } : dense ? DENSE_NODE : NODE;
  return (
    <div
      data-study-children=""
      className="absolute grid grid-cols-3"
      style={{ left, top, gap }}
    >
      {types.map((type, index) => (
        <StudyNode
          key={`${type}-${index}`}
          type={type}
          {...size}
          zoom={zoom}
          variant={variant}
          frameOverview={frameOverview}
          shortTitle={tall}
        />
      ))}
    </div>
  );
}

function StudyFrame({
  zoom,
  variant,
  dense = false,
  title,
}: {
  zoom: number;
  variant: Variant;
  dense?: boolean;
  title: string;
}) {
  const { frameSize: size, metrics: layout } = dense
    ? DENSE_FRAME
    : GROUPED_FRAME;
  const visual = frameVisualMetricsForSize(size.width, size.height);
  const header = getFrameHeaderMetrics(
    layout.contentSpacing,
    size.width,
    visual.titleFontSize,
    visual.headerInset,
  );
  const [previousNameVisible, setPreviousNameVisible] = useState<boolean>();
  const name = farFramePresentation(
    header.maxWidth * zoom,
    layout.headerInset * zoom,
    header.fontSize * zoom,
    previousNameVisible,
  );
  if (previousNameVisible !== (name.opacity === 1))
    setPreviousNameVisible(name.opacity === 1);
  const [previousRegionActive, setPreviousRegionActive] = useState(false);
  const region = farFrameRegionPresentation(
    size.width * zoom,
    size.height * zoom,
    zoom,
    previousRegionActive,
    header,
  );
  if (previousRegionActive !== region.active)
    setPreviousRegionActive(region.active);
  const proposed = variant === 'proposal';
  const regionVisible = proposed && (region.visible || region.fallbackVisible);
  const headerOpacity = proposed ? (regionVisible ? 0 : name.opacity) : 1;
  return (
    <FrameSurface
      data-study-frame=""
      accent={ACCENT}
      borderRadius={visual.borderRadius}
      className="relative shrink-0 overflow-hidden"
      style={size}
    >
      <div
        data-study-frame-name=""
        style={{ opacity: headerOpacity }}
        aria-hidden={headerOpacity === 0}
      >
        <FrameHeader
          accent={ACCENT}
          metrics={
            proposed
              ? {
                  ...header,
                  fontSize: name.fontSize / zoom,
                  height: name.lineHeight / zoom,
                  top: Math.max(
                    0,
                    (layout.headerInset - name.lineHeight / zoom) / 2,
                  ),
                }
              : header
          }
        >
          <span
            className="text-fg-default truncate font-semibold"
            style={
              proposed
                ? { lineHeight: `${name.lineHeight / zoom}px` }
                : undefined
            }
          >
            {title}
          </span>
        </FrameHeader>
      </div>
      <StudyNodes
        zoom={zoom}
        variant={variant}
        dense={dense}
        left={layout.contentSpacing}
        top={layout.headerInset}
        gap={layout.contentSpacing}
        frameOverview={regionVisible}
      />
      {proposed && (
        <div
          data-study-frame-region=""
          aria-hidden={!regionVisible}
          className="pointer-events-none absolute inset-0 z-10"
          style={{ opacity: regionVisible ? 1 : 0 }}
        >
          <FrameRegionLabel
            title={title}
            childCount={dense ? 6 : 3}
            accent={ACCENT}
            zoom={zoom}
            layout={region}
            headerMetrics={header}
          />
        </div>
      )}
    </FrameSurface>
  );
}

function Scene({
  zoom,
  context,
  variant,
}: {
  zoom: number;
  context: Context;
  variant: Variant;
}) {
  const size =
    context === 'tall'
      ? { width: 1400, height: 960 }
      : context === 'dense'
        ? {
            width: DENSE_FRAME.frameSize.width * 2 + FRAME_GAP,
            height: DENSE_FRAME.frameSize.height,
          }
        : context === 'grouped'
          ? GROUPED_FRAME.frameSize
          : SCENE;
  return (
    <section className="space-y-3" aria-label={`${context} ${variant}`}>
      <h3 className="text-fg-muted text-sm">
        {variant === 'baseline'
          ? 'Original scaling'
          : 'Progressive titles · proposal'}
      </h3>
      <div
        className="bg-bg-default overflow-x-auto rounded-lg p-4"
        role="region"
        aria-label={`${context} ${variant} zoom reference`}
      >
        <div
          className="relative"
          style={{ width: size.width * zoom, height: size.height * zoom }}
        >
          <div
            data-study-scene={context}
            data-study-variant={variant}
            className="absolute origin-top-left"
            style={{ ...size, transform: `scale(${zoom})` }}
          >
            {context === 'dense' ? (
              <div className="flex" style={{ gap: FRAME_GAP }}>
                <StudyFrame
                  zoom={zoom}
                  variant={variant}
                  dense
                  title="研究资料与工作笔记"
                />
                <StudyFrame
                  zoom={zoom}
                  variant={variant}
                  dense
                  title="设计判断与后续验证"
                />
              </div>
            ) : context === 'grouped' ? (
              <StudyFrame
                zoom={zoom}
                variant={variant}
                title="研究资料与工作笔记"
              />
            ) : (
              <StudyNodes
                zoom={zoom}
                variant={variant}
                tall={context === 'tall'}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Isolated far-zoom proposal; no production canvas state or LOD writes. */
export function ZoomReadabilityStudy() {
  const [percent, setPercent] = useState(50);
  const zoom = percent / 100;
  return (
    <div id="zoomed-overview" className="scroll-mt-24 space-y-5">
      <div className="border-edge-default bg-surface space-y-3 rounded-lg border p-4">
        <h3 className="text-fg-default text-sm font-semibold">
          Progressive far-zoom titles · compare with original scaling
        </h3>
        <p className="text-fg-muted text-sm">
          At 400px × 50% = 200px on screen, keep the existing content. Zoom out
          to hand off to left-aligned titles inside the same boundaries. At
          greater distances, a centered Frame name without a marker replaces
          child text. Child silhouettes and positions remain unchanged; no extra
          header space is reserved.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <RangeSlider
            label="Readability study zoom"
            value={percent}
            min={5}
            max={100}
            onChange={setPercent}
            showValue={false}
          />
          <output
            className="text-fg-default text-sm tabular-nums"
            data-study-readout=""
          >
            {percent}% · node {Math.round(NODE.width * zoom)} ×{' '}
            {Math.round(NODE.height * zoom)}px
          </output>
          {PRESETS.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={value === percent ? 'solid' : 'outline'}
              aria-pressed={value === percent}
              onClick={() => setPercent(value)}
            >
              {value}%
            </Button>
          ))}
        </div>
        <p className="text-fg-subtle text-xs">
          Experimental screen-pixel budgets: content switches to titles below
          20% viewport zoom and returns at 24%. Titles use 9px / 13px, weight
          500, with up to 6px insets and every complete fitting line.
          Descriptions use 7px / 10px with a 2px gap. Frame region names take
          over below a viewport zoom of 8% and release at 10%, with best-effort
          root fallback. Node titles reduce padding before hiding when one em of
          width or a complete line no longer fits. Text is either fully visible
          or hidden, with no opacity fade. Existing summaries or Note excerpts
          use the remaining space after the displayed title and gap. One
          complete line is enough; there is no minimum text width or fixed
          description line limit. Descriptions never displace titles. Nothing
          extends beyond its node. These are starting values, not established
          readability thresholds. This does not simulate production LOD or
          reading activation. The Web cover is sample artwork; PDF uses the
          existing no-cover card.
        </p>
      </div>
      <FarLabelTypographyComparison />
      {(['independent', 'tall', 'grouped', 'dense'] as const).map((context) => (
        <Comparison key={context} context={context}>
          <Scene zoom={zoom} context={context} variant="baseline" />
          <Scene zoom={zoom} context={context} variant="proposal" />
        </Comparison>
      ))}
    </div>
  );
}

function Comparison({
  context,
  children,
}: {
  context: Context;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" data-study-comparison={context}>
      <h3 className="text-fg-default text-sm font-semibold">
        {context === 'independent'
          ? 'Independent nodes · 400px'
          : context === 'tall'
            ? 'Short titles · tall nodes · 400 × 700px'
            : context === 'grouped'
              ? 'Inside a Frame · 400px'
              : 'Dense groups · 240px nodes'}
      </h3>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">{children}</div>
    </section>
  );
}
