// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Check,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Pencil,
  ShieldQuestion,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/Common/Button';
import { RangeSlider } from '@/components/Common/RangeSlider';
import { nodeBoundaryForAccent } from '@/components/Nodes/design/nodeBoundary';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { noteSurfaceStyle } from '@/components/Nodes/note/noteDesign';
import { QuestionTakeoverMark } from '@/components/Nodes/question/QuestionTakeoverMark';
import { lerp } from '@/config/nodeTakeover';

import {
  badgeSizeForNode,
  collapsedMarkSize,
  collapseProgress,
} from './legacyQuestionTakeover';

import type { QuestionAgentBadgeStatus } from '@/components/Nodes/question/questionBadgeChrome';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { LucideIcon } from 'lucide-react';

export type QuestionStudyState =
  | 'draft'
  | 'running'
  | 'approval'
  | 'unread'
  | 'viewed'
  | 'error';

export const STATUS: Record<
  QuestionStudyState,
  {
    label: string;
    mark: QuestionAgentBadgeStatus | 'idle';
    icon: LucideIcon;
    tone: string;
  }
> = {
  draft: { label: '待开始', mark: 'idle', icon: Pencil, tone: 'neutral' },
  running: {
    label: '进行中',
    mark: 'running',
    icon: LoaderCircle,
    tone: 'info',
  },
  approval: {
    label: '等你授权',
    mark: 'approval',
    icon: ShieldQuestion,
    tone: 'warning',
  },
  unread: {
    label: '本轮结束 · 未查看',
    mark: 'done',
    icon: MessageCircle,
    tone: 'success',
  },
  viewed: { label: '已查看', mark: 'done', icon: Check, tone: 'neutral' },
  error: {
    label: '运行出错',
    mark: 'error',
    icon: CircleAlert,
    tone: 'danger',
  },
};

const WIDTH = 400;
const HEIGHT = 220;

/** Playground-only screen-space budgets, not production takeover thresholds. */
export function questionStudyLayout(zoom: number) {
  const width = WIDTH * zoom;
  const height = HEIGHT * zoom;
  const showQuestion = width >= 100;
  const showStatusText = width >= 200;
  const showDetail = width >= 400;
  const canonicalSize = lerp(
    badgeSizeForNode(width, height),
    collapsedMarkSize(width, height),
    collapseProgress(width),
  );
  return {
    width,
    height,
    showQuestion,
    showStatusText,
    showDetail,
    // A deliberate proposal floor: the historical geometry can shrink to 6px.
    markSize: Math.max(28, Math.min(38, canonicalSize)),
  };
}

export function QuestionStatusSpecimen({
  zoom,
  state,
  agent,
  title,
  showExample = false,
  onOpen,
}: {
  zoom: number;
  state: QuestionStudyState;
  agent: QuestionAgentPresentation;
  title: string;
  showExample?: boolean;
  onOpen: () => void;
}) {
  const layout = questionStudyLayout(zoom);
  const info = STATUS[state];
  const Icon = info.icon;
  const label = `${info.label} · ${title} · ${agent.alias}`;
  const unread = state === 'unread' || state === 'error';
  return (
    <div
      className="qs-node"
      data-zoom={zoom}
      data-state={state}
      data-layer={
        layout.showDetail
          ? 'detail'
          : layout.showQuestion
            ? 'question'
            : 'status'
      }
      style={{ width: layout.width, height: layout.height }}
    >
      {layout.showQuestion ? (
        <div
          className="qs-shell"
          aria-hidden
          style={{
            ...noteSurfaceStyle(null),
            ...nodeBoundaryForAccent(null),
            width: WIDTH,
            height: HEIGHT,
            borderRadius: nodeMetricsForSize(WIDTH, HEIGHT).radius,
            transform: `scale(${zoom})`,
          }}
        />
      ) : null}
      {layout.showQuestion ? (
        <div
          className="qs-question-content"
          style={{ paddingTop: layout.showStatusText ? 62 : 34 }}
        >
          <h3
            style={{
              fontSize: layout.showDetail ? 20 : 13,
              lineHeight: layout.showDetail ? '28px' : '18px',
              WebkitLineClamp: layout.showDetail
                ? 2
                : layout.showStatusText
                  ? 2
                  : 1,
            }}
            title={title}
          >
            {title}
          </h3>
          {layout.showDetail ? (
            <>
              <p className="qs-original-question">
                用户原问：参考画布上的产品资料，帮我整理网站的内容结构。
              </p>
              {showExample ? (
                <p className="qs-agent-detail">
                  <span>示例 · 非实时数据</span>
                  {state === 'running'
                    ? 'AI 活动：正在读取产品资料。'
                    : state === 'approval'
                      ? 'AI 请求：希望访问资料中的外部链接。'
                      : state === 'unread' || state === 'viewed'
                        ? 'AI 回复：建议按产品组织入口，再细分指南与常见问题。'
                        : state === 'error'
                          ? '错误示例：外部链接读取失败。'
                          : '还没有 Agent 回复。'}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div
        className="qs-mark"
        style={{
          left: layout.showQuestion ? 10 : (layout.width - layout.markSize) / 2,
          top: layout.showQuestion
            ? layout.showStatusText
              ? 8
              : -16
            : (layout.height - layout.markSize) / 2,
        }}
      >
        <QuestionTakeoverMark
          state={{
            stage:
              state === 'draft' || !layout.showQuestion
                ? 'collapsed'
                : 'readable',
            size: layout.markSize,
          }}
          status={info.mark}
          agent={agent}
          unread={unread}
          conflictCount={0}
          interactive
          onOpen={onOpen}
          accessibleLabel={label}
          tooltip={label}
        />
        {!layout.showStatusText && state !== 'approval' ? (
          <span className="qs-state-symbol" data-tone={info.tone} aria-hidden>
            <Icon size={12} />
          </span>
        ) : null}
      </div>
      {layout.showStatusText ? (
        <>
          {layout.showDetail ? (
            <span className="qs-agent-name" title={agent.alias}>
              对话 · {agent.alias}
            </span>
          ) : null}
          <span className="qd-status qs-status-label" data-tone={info.tone}>
            <Icon size={14} aria-hidden />
            {info.label}
          </span>
        </>
      ) : null}
    </div>
  );
}

export function QuestionStatusZoomStudy({
  state,
  agent,
  title,
  onOpen,
}: {
  state: QuestionStudyState;
  agent: QuestionAgentPresentation;
  title: string;
  onOpen: (state: QuestionStudyState) => void;
}) {
  const [zoom, setZoom] = useState(75);
  const [showExample, setShowExample] = useState(false);
  return (
    <section
      className="qs-study"
      aria-label="当前方案：状态优先"
      id="current-question-design"
    >
      <header className="qd-section-header">
        <div>
          <p className="qd-eyebrow">当前方案 · 状态优先的紧凑对话节点</p>
          <h2>先看状态，再看问题，最后看 AI 信息。</h2>
        </div>
        <span className="qd-recommended">设计预览，未替换正式节点</span>
      </header>
      <div className="qs-controls">
        <span>画布缩放 {zoom}%</span>
        <RangeSlider
          min={5}
          max={100}
          value={zoom}
          onChange={setZoom}
          showValue={false}
          label="Question 预览缩放"
        />
        {[100, 75, 50, 25, 10, 5].map((value) => (
          <Button
            key={value}
            size="sm"
            variant={zoom === value ? 'solid' : 'outline'}
            aria-pressed={zoom === value}
            onClick={() => setZoom(value)}
          >
            {value}%
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          aria-pressed={showExample}
          onClick={() => setShowExample(!showExample)}
        >
          显示 AI 信息样例
        </Button>
      </div>
      <div className="qs-live qd-grid-surface">
        <QuestionStatusSpecimen
          zoom={zoom / 100}
          state={state}
          agent={agent}
          title={title}
          showExample={showExample}
          onOpen={() => onOpen(state)}
        />
      </div>
      <p className="qs-explanation">
        拖动滑块看实际尺寸变化：状态标记不随卡片等比例缩小；先隐藏 AI
        信息，再隐藏问题。右上角文字放不下时，由头像旁的状态符号接替。点击或键盘聚焦标记可识别并打开对应对话。
      </p>
      <div className="qs-scale-row">
        {[1, 0.5, 0.25, 0.1, 0.05].map((value) => (
          <div className="qs-scale-cell" key={value}>
            <span>{Math.round(value * 100)}%</span>
            <div className="qs-scale-stage">
              <QuestionStatusSpecimen
                zoom={value}
                state={state}
                agent={agent}
                title={title}
                showExample={showExample}
                onOpen={() => onOpen(state)}
              />
            </div>
          </div>
        ))}
      </div>
      <h3 className="qs-state-heading">缩到 10%：比较状态，而不是辨认小字</h3>
      <div className="qs-state-row qd-grid-surface">
        {(Object.keys(STATUS) as QuestionStudyState[]).map((value) => (
          <div key={value}>
            <div className="qs-small-stage">
              <QuestionStatusSpecimen
                zoom={0.1}
                state={value}
                agent={agent}
                title={title}
                onOpen={() => onOpen(value)}
              />
            </div>
            <span>{STATUS[value].label}</span>
          </div>
        ))}
      </div>
      <p className="qs-explanation">
        复用现有 Agent 状态环、授权标记与未查看提醒。本实验额外保留至少 28px
        的标记与 12px
        状态符号，最小缩放时可能超出节点原始范围；密集画布的重叠仍需验证。下方文字是图例，不是远距节点内容。AI
        活动／回复样例默认关闭，正式接入需有真实事件或回复来源。
      </p>
    </section>
  );
}
