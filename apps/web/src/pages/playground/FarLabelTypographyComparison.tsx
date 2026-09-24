// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useRef, useState } from 'react';

import { resolveAccent } from '@huabu/shared';

import { RangeSlider } from '@/components/Common/RangeSlider';
import {
  FAR_ZOOM_DESIGN,
  type FarZoomDesign,
} from '@/components/Nodes/design/farZoomDesign';
import {
  NODE_BORDER_WIDTH,
  nodeBoundaryForAccent,
} from '@/components/Nodes/design/nodeBoundary';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { noteSurfaceStyle } from '@/components/Nodes/note/noteDesign';
import { FarZoomLabel } from '@/components/Nodes/semanticZoom/FarZoomLabel';
import { resolveFarLabelLayout } from '@/config/semanticZoom';

/** Historical comparison only; the right column uses production defaults. */
const PREVIOUS: FarZoomDesign = {
  ...FAR_ZOOM_DESIGN,
  labelWeight: 500,
  labelInsetInline: 6,
  descriptionFont: 9,
  descriptionLine: 12,
};

const SAMPLES = [
  {
    name: 'Long Chinese title',
    title: 'Orca：以任务工作区为中心的 Agent 工作环境',
    description: '核心管理单元是任务工作区，而不只是终端窗口。',
    width: 400,
    height: 320,
    accent: 'grey',
  },
  {
    name: 'Short English title · tall node',
    title: 'tmux',
    description: '管理多个终端会话，支持分屏与会话恢复。',
    width: 400,
    height: 700,
    accent: 'teal',
  },
  {
    name: 'Narrow node',
    title: '来源卡｜Orca 官方 GitHub 仓库',
    description: '切入点是并发管理，而不是代码生成。',
    width: 240,
    height: 320,
    accent: 'purple',
  },
  {
    name: 'Shallow node · title priority',
    title: '工作区与任务管理',
    description: '描述只使用标题之后的剩余空间。',
    width: 400,
    height: 86,
    accent: 'grey',
  },
] as const;

function Specimen({
  sample,
  zoom,
  design,
}: {
  sample: (typeof SAMPLES)[number];
  zoom: number;
  design: FarZoomDesign;
}) {
  const previous = useRef<boolean | undefined>(undefined);
  const layout = resolveFarLabelLayout(
    (sample.width - 2 * NODE_BORDER_WIDTH) * zoom,
    (sample.height - 2 * NODE_BORDER_WIDTH) * zoom,
    previous.current,
    design,
  );
  previous.current = layout.labelRetained;
  const accent = resolveAccent(sample.accent);
  const radius = nodeMetricsForSize(sample.width, sample.height).radius;
  return (
    <div style={{ width: sample.width * zoom, height: sample.height * zoom }}>
      <article
        data-typography-specimen={sample.name}
        aria-label={sample.title}
        className="relative origin-top-left overflow-hidden border-solid"
        style={{
          boxSizing: 'border-box',
          width: sample.width,
          height: sample.height,
          transform: `scale(${zoom})`,
          borderRadius: radius,
          ...nodeBoundaryForAccent(accent),
          ...noteSurfaceStyle(accent),
        }}
      >
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ borderRadius: Math.max(0, radius - NODE_BORDER_WIDTH) }}
        >
          <FarZoomLabel
            title={sample.title}
            description={sample.description}
            width={layout.availableWidth}
            height={layout.availableHeight}
            lines={layout.lines}
            verticalInset={layout.verticalInset}
            horizontalInset={layout.horizontalInset}
            zoom={zoom}
            visible={layout.labelRetained}
            design={design}
          />
        </div>
      </article>
    </div>
  );
}

/** Isolated typography comparison; no canvas store, content, or geometry writes. */
export function FarLabelTypographyComparison() {
  const [percent, setPercent] = useState(24);
  return (
    <section
      id="far-label-typography"
      className="border-edge-default bg-surface scroll-mt-24 space-y-4 rounded-lg border p-4"
      aria-label="Far-label typography comparison"
    >
      <h3 className="text-fg-default text-sm font-semibold">
        Far-label typography · previous vs adopted
      </h3>
      <p className="text-fg-muted text-sm">
        Identical content, geometry, accents, and production shell tokens. Only
        text metrics differ. This isolates the far-label layer at every zoom; it
        does not simulate content switching or Frame takeover. The right column
        is the adopted production design; the left preserves the previous
        design.
      </p>
      <div className="flex items-center gap-3">
        <RangeSlider
          label="Typography comparison zoom"
          value={percent}
          min={5}
          max={50}
          onChange={setPercent}
        />
        <span className="text-fg-subtle text-xs">
          % · both columns share the same zoom
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[480px] grid-cols-2 gap-x-6 gap-y-4">
          <p className="text-fg-muted text-xs">
            Previous · title 12/16 · weight 500 · description 9/12 · inset 6
          </p>
          <p className="text-fg-muted text-xs">
            Adopted · title 12/16 · weight 600 · description 10/14 · horizontal
            inset 8
          </p>
          {SAMPLES.map((sample) => (
            <div
              key={sample.name}
              className="col-span-2 grid grid-cols-subgrid gap-y-2"
            >
              <p className="text-fg-subtle col-span-2 text-xs">
                {sample.name} · {sample.width} × {sample.height} canvas px
              </p>
              {(['previous', 'adopted'] as const).map((variant) => (
                <div
                  key={variant}
                  data-typography-variant={variant}
                  className="bg-bg-default rounded-lg p-3"
                >
                  <Specimen
                    sample={sample}
                    zoom={percent / 100}
                    design={variant === 'previous' ? PREVIOUS : FAR_ZOOM_DESIGN}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
