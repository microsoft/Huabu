// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import {
  ACCENT_PALETTE,
  resolveAccent,
  type AccentToken,
  type SpaceInstructionFrameKind,
} from '@huabu/shared';

import { ColorPicker } from '@/components/Common/ColorPicker';
import { Select } from '@/components/Common/Select';
import {
  FRAME_DESIGN_CONFIG,
  frameVisualMetricsForSize as frameResponsiveMetricsForSize,
  type FrameVisualMetrics as FrameResponsiveMetrics,
} from '@/components/Nodes/frame/frameDesign';
import { FrameHeader } from '@/components/Nodes/frame/FrameHeader';
import { getFrameHeaderMetrics } from '@/components/Nodes/frame/frameHeaderMetrics';
import { FrameSurface } from '@/components/Nodes/frame/FrameSurface';

import { NoteDesignDraft } from './NoteDesignDraft';
import { SelectionFramePlayground } from './SelectionFramePlayground';
import { ZoomReadabilityStudy } from './ZoomReadabilityStudy';

import type { FrameResponsiveTier } from '@huabu/shared/canvas-engine';

type PreviewLayout = 'free' | 'column' | 'row' | 'grid';
type PreviewKind = 'plain' | SpaceInstructionFrameKind;

interface FramePreset {
  id: FrameResponsiveTier;
  width: number;
  height: number;
}

const FRAME_PRESETS: readonly FramePreset[] = [
  { id: 'compact', width: 720, height: 540 },
  { id: 'regular', width: 1380, height: 876 },
  { id: 'large', width: 2400, height: 1800 },
];

const LAYOUT_OPTIONS: Array<{ value: PreviewLayout; label: string }> = [
  { value: 'free', label: 'Free' },
  { value: 'column', label: 'Column' },
  { value: 'row', label: 'Row' },
  { value: 'grid', label: 'Grid' },
];

const KIND_OPTIONS: Array<{ value: PreviewKind; label: string }> = [
  { value: 'plain', label: 'Standard' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'skill', label: 'Skill' },
];

const TIER_LABELS: Record<FrameResponsiveTier, string> = {
  compact: 'Compact',
  regular: 'Regular',
  large: 'Large',
};

function resolveTier(metrics: FrameResponsiveMetrics): FrameResponsiveTier {
  return (
    FRAME_DESIGN_CONFIG.tiers.find(
      (tier) => tier.titleFontSize === metrics.titleFontSize,
    )?.id ?? 'regular'
  );
}

function PreviewNode({
  title,
  metrics,
  className,
}: {
  title: string;
  metrics: FrameResponsiveMetrics;
  className?: string;
}) {
  return (
    <div
      className={`border-edge-default bg-bg-default flex min-h-0 flex-col overflow-hidden border ${className ?? ''}`}
      style={{
        borderRadius: metrics.borderRadius * 0.6,
        padding: metrics.contentSpacing * 0.6,
        gap: metrics.contentSpacing * 0.4,
      }}
    >
      <span
        className="text-fg-default truncate font-semibold"
        style={{ fontSize: Math.max(16, metrics.titleFontSize * 0.48) }}
      >
        {title}
      </span>
      <div
        className="bg-edge-default rounded-full"
        style={{
          width: '72%',
          height: Math.max(6, metrics.titleFontSize * 0.12),
        }}
      />
      <div
        className="bg-edge-default rounded-full opacity-70"
        style={{
          width: '48%',
          height: Math.max(6, metrics.titleFontSize * 0.12),
        }}
      />
    </div>
  );
}

function FrameContents({
  layout,
  metrics,
}: {
  layout: PreviewLayout;
  metrics: FrameResponsiveMetrics;
}) {
  const gap = metrics.contentSpacing;

  if (layout === 'free') {
    return (
      <div className="relative h-full">
        <PreviewNode
          title="Overview"
          metrics={metrics}
          className="absolute top-0 left-0 h-[42%] w-[44%]"
        />
        <PreviewNode
          title="References"
          metrics={metrics}
          className="absolute top-[12%] right-[4%] h-[36%] w-[40%]"
        />
        <PreviewNode
          title="Next steps"
          metrics={metrics}
          className="absolute bottom-[2%] left-[24%] h-[34%] w-[48%]"
        />
      </div>
    );
  }

  if (layout === 'column') {
    return (
      <div className="grid h-full grid-cols-2" style={{ columnGap: gap }}>
        <div className="flex min-h-0 flex-col" style={{ gap }}>
          <PreviewNode title="Overview" metrics={metrics} className="flex-1" />
          <PreviewNode
            title="Research"
            metrics={metrics}
            className="flex-[0.72]"
          />
        </div>
        <div className="flex min-h-0 flex-col" style={{ gap }}>
          <PreviewNode
            title="References"
            metrics={metrics}
            className="flex-[0.82]"
          />
          <PreviewNode
            title="Next steps"
            metrics={metrics}
            className="flex-1"
          />
        </div>
      </div>
    );
  }

  if (layout === 'row') {
    return (
      <div className="grid h-full grid-rows-2" style={{ rowGap: gap }}>
        <div className="flex min-h-0" style={{ gap }}>
          <PreviewNode title="Overview" metrics={metrics} className="flex-1" />
          <PreviewNode
            title="Research"
            metrics={metrics}
            className="flex-[0.78]"
          />
        </div>
        <div className="flex min-h-0" style={{ gap }}>
          <PreviewNode
            title="References"
            metrics={metrics}
            className="flex-[0.72]"
          />
          <PreviewNode
            title="Next steps"
            metrics={metrics}
            className="flex-1"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-2 grid-rows-2" style={{ gap }}>
      <PreviewNode title="Overview" metrics={metrics} />
      <PreviewNode title="Research" metrics={metrics} />
      <PreviewNode title="References" metrics={metrics} />
      <PreviewNode title="Next steps" metrics={metrics} />
    </div>
  );
}

function FrameSpecimen({
  width,
  height,
  layout,
  accent,
  kind,
  maxPreviewWidth = 620,
  maxPreviewHeight = 380,
}: {
  width: number;
  height: number;
  layout: PreviewLayout;
  accent: AccentToken;
  kind: PreviewKind;
  maxPreviewWidth?: number;
  maxPreviewHeight?: number;
}) {
  const metrics = frameResponsiveMetricsForSize(width, height);
  const tier = resolveTier(metrics);
  const scale = Math.min(1, maxPreviewWidth / width, maxPreviewHeight / height);
  const resolvedAccent = resolveAccent(accent);
  const headerMetrics = getFrameHeaderMetrics(
    metrics.contentSpacing,
    width,
    metrics.titleFontSize,
    metrics.headerInset,
  );

  return (
    <div
      className="relative shrink-0"
      style={{ width: width * scale, height: height * scale }}
    >
      <FrameSurface
        accent={resolvedAccent}
        borderRadius={metrics.borderRadius}
        className="absolute top-0 left-0 overflow-hidden border-3"
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <FrameHeader
          metrics={headerMetrics}
          accent={resolvedAccent}
          instructionKind={kind === 'plain' ? null : kind}
        >
          <span className="text-fg-default col-start-1 row-start-1 min-w-0 truncate font-semibold">
            {TIER_LABELS[tier]} Frame
          </span>
        </FrameHeader>

        <div
          className="absolute"
          style={{
            top: metrics.headerInset,
            right: metrics.contentSpacing,
            bottom: metrics.contentSpacing,
            left: metrics.contentSpacing,
          }}
        >
          <FrameContents layout={layout} metrics={metrics} />
        </div>
      </FrameSurface>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-edge-default bg-surface overflow-hidden rounded-xl border">
      <div className="border-edge-default border-b px-6 py-4">
        <h2 className="text-fg-default text-base font-semibold">{title}</h2>
        <p className="text-fg-muted mt-1 text-sm">{description}</p>
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}

export default function FrameDesignPlaygroundPage() {
  const [layout, setLayout] = useState<PreviewLayout>('grid');
  const [kind, setKind] = useState<PreviewKind>('plain');
  const [accent, setAccent] = useState<AccentToken>('purple');
  const selectAccent = (token: string) => {
    const option = ACCENT_PALETTE.find(
      (candidate) => candidate.token === token,
    );
    if (option) setAccent(option.token);
  };

  return (
    <div className="bg-bg-default h-full overflow-auto">
      <header className="border-edge-default bg-bg-default/95 sticky top-0 z-20 border-b px-6 py-4 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-fg-default text-lg font-semibold">
              Canvas design playground
            </h1>
            <p className="text-fg-muted mt-1 text-xs">
              Production canvas surfaces and responsive design proposals.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-8">
        <Section
          title="Frame"
          description="Compact, Regular, and Large presets using production Frame surfaces and headers. Accent, layout, and header controls apply to all three."
        >
          <div className="mb-6 flex flex-wrap items-end gap-6">
            <div>
              <div className="text-fg-muted mb-2 text-xs font-medium">
                Accent
              </div>
              <ColorPicker
                colors={ACCENT_PALETTE}
                activeToken={accent}
                onSelect={selectAccent}
              />
            </div>
            <div className="flex min-w-32 flex-col gap-1.5">
              <span className="text-fg-muted text-xs">Layout</span>
              <Select
                options={LAYOUT_OPTIONS}
                value={layout}
                onChange={setLayout}
                ariaLabel="Frame layout"
                className="w-full"
              />
            </div>
            <div className="flex min-w-32 flex-col gap-1.5">
              <span className="text-fg-muted text-xs">Header</span>
              <Select
                options={KIND_OPTIONS}
                value={kind}
                onChange={setKind}
                ariaLabel="Frame header kind"
                className="w-full"
              />
            </div>
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            {FRAME_PRESETS.map((preset) => {
              const presetMetrics = frameResponsiveMetricsForSize(
                preset.width,
                preset.height,
              );
              return (
                <article
                  key={preset.id}
                  className="border-edge-default bg-bg-default overflow-hidden rounded-lg border"
                >
                  <div className="flex min-h-64 items-center justify-center overflow-auto p-5">
                    <FrameSpecimen
                      width={preset.width}
                      height={preset.height}
                      layout={layout}
                      accent={accent}
                      kind={kind}
                      maxPreviewWidth={300}
                      maxPreviewHeight={210}
                    />
                  </div>
                  <div className="border-edge-default bg-surface border-t p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-fg-default text-sm font-semibold">
                        {TIER_LABELS[preset.id]}
                      </h3>
                      <span className="text-fg-subtle text-xs tabular-nums">
                        {preset.width} × {preset.height}
                      </span>
                    </div>
                    <p className="text-fg-muted mt-2 text-xs tabular-nums">
                      Title {presetMetrics.titleFontSize} · Header{' '}
                      {presetMetrics.headerInset} · Radius{' '}
                      {presetMetrics.borderRadius} · Spacing{' '}
                      {presetMetrics.contentSpacing}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </Section>

        <Section
          title="Note"
          description="Compact, Regular, and Large presets using production Note rendering, typography, and card surfaces."
        >
          <NoteDesignDraft />
        </Section>

        <Section
          title="Zoom readability"
          description="Original scaling versus progressive titles, starting with 400px nodes at 50% zoom. Compare independent nodes, a Frame, and dense groups at the same scale. Playground proposal only."
        >
          <ZoomReadabilityStudy />
        </Section>

        <Section
          title="Selection frame"
          description="Interactive proposal: a stable external connector, image corner scaling, and text width controls. Production selection behavior is unchanged."
        >
          <SelectionFramePlayground />
        </Section>
      </main>
    </div>
  );
}
