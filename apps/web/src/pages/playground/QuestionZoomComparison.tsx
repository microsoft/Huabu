// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { AGENT_ICON_COLORS } from '@/components/Common/AgentIcon';
import { Button } from '@/components/Common/Button';
import { RangeSlider } from '@/components/Common/RangeSlider';
import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { QuestionAgentBubble } from '@/components/Nodes/question/QuestionAgentBubble';
import '@/components/Nodes/question/QuestionAgentBadge.css';
import { useQuestionHeaderFit } from '@/components/Nodes/question/useQuestionHeaderFit';
import { resolveNodePresentation } from '@/config/semanticZoom';

import { CopilotPreviewIcon } from './CopilotPreviewIcon';
import { STATUS } from './QuestionStatusZoomStudy';
import { useQuestionTitleHeight } from './useQuestionTitleHeight';
import './QuestionZoomComparison.css';

import type { QuestionStudyState } from './QuestionStatusZoomStudy';
import type { AgentIconColor } from '@/components/Common/AgentIcon';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { CSSProperties } from 'react';

export type QuestionZoomDirection = 'card' | 'fusion' | 'adaptive' | 'rail';
const DIRECTIONS = {
  card: {
    title: 'A · 新卡片延续版',
    description:
      '圆角矩形贯穿远近：名称按实际剩余空间显示，状态优先，卡片高度随标题换行撑开。不因缩放百分比提前隐藏文字。运行仍用独立蓝色转圈。',
  },
  fusion: {
    title: 'B · 卡片 × 头像环融合版',
    description:
      '卡片布局固定，整体等比例缩放，运行环使用主题蓝色。进入远景时整体切换为头像与一层状态环；仅等待授权保留右上贴边盾牌。',
  },
  adaptive: {
    title: 'C · 近景简洁卡片 → 远景头像环',
    description:
      '卡片布局不变；低于 25% 切换为头像，放大至 30% 恢复卡片。远景保留纯色状态外框与运行旋转，不使用渐变；未查看时轻摇配淡光晕，待授权时盾牌配缓慢扩散光环。',
  },
  rail: {
    title: 'D · 左侧色线融合版',
    description:
      '参考「紧凑布局，轻量状态。」：保留系统 28px 标题，搭配小头像与轻量状态文字。左侧留白 32px、右侧 24px，打开时色线与边框同色，显示浅底描边和对话尾角，内容不移位；远景切换规则与 C 一致。',
  },
} as const;
const SCALES = [1, 0.75, 0.5, 0.25, 0.1];
const STATES = Object.keys(STATUS) as QuestionStudyState[];
const COLOR_NAMES: Record<AgentIconColor, string> = {
  blue: '蓝色',
  red: '红色',
  yellow: '黄色',
  green: '绿色',
};
/** Scale authored geometry without reflow; titleHeight is measured in canvas units. */
export function questionZoomComparisonLayout(
  direction: QuestionZoomDirection,
  zoom: number,
  titleHeight = 0,
  minimal = resolveNodePresentation(zoom, 0, 0, 'overview', false) ===
    'minimal',
) {
  const z = Math.max(0, zoom);
  const collapse = direction !== 'card' && minimal ? 1 : 0;
  const mark = 128 * z;
  const roomy = direction === 'adaptive' || direction === 'rail';
  const cardWidth = (roomy ? 440 : 400) * z;
  const width = collapse ? mark : cardWidth;
  const padding = (roomy ? 20 : 16) * z;
  const contentLeft = (direction === 'rail' ? 32 : 16) * z;
  const contentRight = (direction === 'rail' ? 24 : 16) * z;
  const contentWidth = cardWidth - contentLeft - contentRight;
  const avatar = collapse ? mark * 0.66 : (direction === 'rail' ? 24 : 32) * z;
  const titleGap = titleHeight > 0 ? (roomy ? 16 : 12) * z : 0;
  const height = collapse
    ? mark
    : padding * 2 + avatar + titleGap + titleHeight * z;
  const avatarX = collapse ? (width - avatar) / 2 : contentLeft;
  const avatarY = collapse ? (height - avatar) / 2 : padding;
  return {
    zoom: z,
    width,
    height,
    collapse,
    padding,
    contentLeft,
    contentRight,
    contentWidth,
    titleGap,
    avatar,
    avatarX,
    avatarY,
    shellOpacity: 1 - collapse,
    radius: collapse ? mark / 2 : 12 * z,
    titleSize: NODE_TYPOGRAPHY.cardTitle.size * z,
    titleWeight: NODE_TYPOGRAPHY.cardTitle.weight,
    titleLineHeight: NODE_TYPOGRAPHY.cardTitle.lineHeight,
    metaSize: NODE_TYPOGRAPHY.metadata.size * z,
    statusSize: (direction === 'rail' ? 14 : NODE_TYPOGRAPHY.metadata.size) * z,
  };
}

export function QuestionZoomSpecimen({
  direction,
  zoom,
  state,
  agent,
  title,
  onOpen,
  isOpen = false,
  useCopilotIcon = false,
  reviewed = false,
  conflictCount = 0,
}: {
  direction: QuestionZoomDirection;
  zoom: number;
  state: QuestionStudyState;
  agent: QuestionAgentPresentation;
  title: string;
  onOpen: () => void;
  isOpen?: boolean;
  useCopilotIcon?: boolean;
  reviewed?: boolean;
  conflictCount?: number;
}) {
  const [previousMode, setPreviousMode] = useState<'minimal' | 'overview'>(
    'overview',
  );
  const mode =
    resolveNodePresentation(zoom, 0, 0, previousMode, false) === 'minimal'
      ? 'minimal'
      : 'overview';
  if (mode !== previousMode) setPreviousMode(mode);
  const minimal = direction !== 'card' && mode === 'minimal';
  const authored = questionZoomComparisonLayout(direction, 1);
  const { ref: titleProbeRef, height: titleHeight } = useQuestionTitleHeight(
    title,
    authored.contentWidth,
    authored.titleSize,
  );
  const l = questionZoomComparisonLayout(direction, 1, titleHeight, minimal);
  const screen = questionZoomComparisonLayout(
    direction,
    zoom,
    titleHeight,
    minimal,
  );
  const info = STATUS[state];
  const Icon = info.icon;
  const fusion = direction === 'fusion';
  const adaptive = direction === 'adaptive' || direction === 'rail';
  const running = state === 'running';
  const schemeC = direction === 'adaptive';
  const terminal =
    state === 'unread' || state === 'error' || state === 'viewed';
  const conflict = schemeC && terminal && conflictCount > 0;
  const needsAttention =
    schemeC &&
    minimal &&
    !isOpen &&
    terminal &&
    ((!reviewed && state !== 'viewed') || conflict);
  const approvalMotion = schemeC && minimal && state === 'approval';
  const workingMotion = schemeC && minimal && running;
  const showBubble = isOpen;
  // The production helper has screen-space floors; these proposals deliberately do not.
  const ring = { inset: l.avatar / 18, width: l.avatar / 12 };
  const approvalBadgeSize = l.avatar * 0.45;
  const statusSize = (direction === 'rail' ? 12 : 16) * l.zoom;
  const showStatusIcon = !fusion && (direction !== 'rail' || running);
  const statusLabel = state === 'unread' ? '待查看' : info.label;
  const aliasLabel = isOpen ? `当前打开 · ${agent.alias}` : agent.alias;
  const { fit, headerRef, aliasRef, labelRef } = useQuestionHeaderFit(
    l.avatar,
    8 * l.zoom,
    showStatusIcon ? statusSize : 0,
    aliasLabel,
    statusLabel,
  );
  const ringOpacity = adaptive ? Number(minimal) : fusion ? 1 : 0;
  const titleTop = l.avatarY + l.avatar + l.titleGap;
  const titleTypography = {
    left: l.contentLeft,
    right: l.contentRight,
    fontSize: l.titleSize,
    lineHeight: l.titleLineHeight,
    fontWeight: l.titleWeight,
  };
  const accessible = `${agent.alias} · ${info.label}${isOpen ? ' · 当前打开' : ''} · ${title}`;
  const statusColor = `var(--${conflict ? 'warning' : info.tone === 'neutral' ? 'fg-muted' : info.tone})`;
  const ringClass = running
    ? 'question-agent-ring-running'
    : state === 'approval'
      ? 'question-agent-ring-approval'
      : state === 'error'
        ? 'question-agent-ring-error'
        : '';
  const quietRingColor = conflict
    ? 'var(--warning)'
    : schemeC && reviewed && terminal
      ? 'var(--edge-default)'
      : state === 'unread'
        ? 'var(--success)'
        : state === 'viewed'
          ? 'var(--edge-default)'
          : schemeC
            ? state === 'draft'
              ? 'var(--edge-default)'
              : `var(--${info.tone}-light)`
            : 'transparent';
  return (
    <div
      className="qzc-scale"
      style={{ width: screen.width, height: screen.height }}
    >
      <article
        className="qzc-node"
        data-direction={direction}
        data-state={state}
        data-zoom={zoom}
        data-open={isOpen}
        data-presentation={minimal ? 'minimal' : 'overview'}
        data-attention={needsAttention}
        data-approval-motion={approvalMotion}
        title={accessible}
        aria-label={accessible}
        style={
          {
            width: l.width,
            height: l.height,
            transform: `scale(${Math.max(0, zoom)})`,
            transformOrigin: 'top left',
            borderRadius: l.radius,
            '--qzc-shell-opacity': l.shellOpacity,
            '--qzc-unit': `${l.zoom}px`,
            '--qzc-tone': statusColor,
            '--qzc-tone-light': `var(--${info.tone === 'neutral' ? 'fg-subtle' : `${info.tone}-light`})`,
            '--qzc-tone-bg': `var(--${info.tone === 'neutral' ? 'bg-hover' : `${info.tone}-bg`})`,
            '--question-agent-running-ring': 'var(--info)',
          } as CSSProperties
        }
      >
        {isOpen && (
          <svg
            className="qzc-open-tail"
            aria-hidden
            viewBox="0 0 32 20"
            style={{
              left: l.contentLeft,
              opacity: l.shellOpacity,
              width: 32 * l.zoom,
              height: 20 * l.zoom,
              bottom: -18 * l.zoom,
            }}
          >
            <path d="M0 0 L6 17 Q7 19 9 17 L30 0" />
          </svg>
        )}
        <div
          className="qzc-header"
          ref={headerRef}
          aria-hidden
          style={{
            left: l.avatarX,
            right: minimal ? l.avatarX : l.contentRight,
            top: l.avatarY,
            height: l.avatar,
            fontSize: l.metaSize,
          }}
        >
          <span ref={aliasRef} className="qzc-fit-probe">
            {aliasLabel}
          </span>
          <span
            ref={labelRef}
            className="qzc-fit-probe"
            style={{ fontSize: l.statusSize }}
          >
            {statusLabel}
          </span>
          <div
            className="qzc-avatar"
            aria-hidden
            style={{
              width: l.avatar,
              height: l.avatar,
            }}
          >
            <span
              className={
                fusion && !showBubble ? `qzc-ring ${ringClass}` : 'qzc-ring'
              }
              style={
                {
                  '--question-agent-special-ring-inset': `${ring.inset}px`,
                  '--question-agent-special-ring-width': `${ring.width}px`,
                  '--qzc-ring-color':
                    fusion && !showBubble && state === 'unread'
                      ? 'var(--success)'
                      : fusion && !showBubble && state === 'viewed'
                        ? 'var(--edge-default)'
                        : 'transparent',
                } as CSSProperties
              }
            >
              {(fusion || adaptive) && showBubble && (
                <QuestionAgentBubble
                  fill="var(--qzc-shell-fill)"
                  className="qzc-active-bubble"
                  style={{
                    left: -l.avatar * 0.1,
                    top: -l.avatar * 0.1,
                    width: l.avatar * 1.2,
                    height: l.avatar * 1.3,
                    opacity: adaptive ? 1 - l.shellOpacity : ringOpacity,
                  }}
                />
              )}
              {useCopilotIcon ? (
                <CopilotPreviewIcon size={l.avatar * 0.72} />
              ) : (
                <AgentAvatarMark
                  agent={agent}
                  size={l.avatar}
                  detail="full"
                  motion={
                    workingMotion || (fusion && running && !showBubble)
                      ? 'working'
                      : 'none'
                  }
                  className="qzc-avatar-art"
                />
              )}
              {adaptive && !showBubble && (
                <span
                  className={`qzc-adaptive-ring ${schemeC && reviewed && state === 'error' ? '' : ringClass}`}
                  style={
                    {
                      opacity: ringOpacity,
                      '--qzc-ring-color': quietRingColor,
                    } as CSSProperties
                  }
                />
              )}
            </span>
            {(fusion || adaptive) && state === 'approval' && (
              <span
                className="qzc-approval-badge"
                style={{
                  width: approvalBadgeSize,
                  height: approvalBadgeSize,
                  top: -approvalBadgeSize * 0.3,
                  right: -approvalBadgeSize * 0.3,
                  opacity: ringOpacity,
                }}
              >
                <Icon size={approvalBadgeSize * 0.62} />
              </span>
            )}
          </div>
          <span
            className="qzc-alias"
            aria-hidden
            style={{
              lineHeight: `${l.avatar}px`,
              display: !minimal && fit.alias ? undefined : 'none',
            }}
          >
            <span>{aliasLabel}</span>
          </span>
          <span
            className="qzc-status"
            aria-hidden
            data-running={running}
            style={{
              color: fusion && running ? 'var(--fg-muted)' : statusColor,
              fontSize: l.statusSize,
              display: !minimal && fit.status ? undefined : 'none',
            }}
          >
            {showStatusIcon && (
              <Icon
                size={statusSize}
                className={running ? 'qzc-spinner' : undefined}
              />
            )}
            <span style={{ display: fit.statusText ? undefined : 'none' }}>
              {statusLabel}
            </span>
          </span>
        </div>
        <div
          ref={titleProbeRef}
          className="qzc-title-probe"
          aria-hidden
          style={{
            ...titleTypography,
            left: authored.contentLeft,
            right: 'auto',
            width: authored.contentWidth,
          }}
        >
          {title}
        </div>
        <div
          className="qzc-title"
          aria-hidden
          style={{
            ...titleTypography,
            top: titleTop,
            height: titleHeight,
            visibility: !minimal && titleHeight > 0 ? undefined : 'hidden',
          }}
        >
          {title}
        </div>
        <Button
          variant="ghost"
          className="qzc-open"
          aria-label={`打开预览：${accessible}`}
          onClick={onOpen}
        >
          <span className="sr-only">打开预览</span>
        </Button>
      </article>
    </div>
  );
}

export function QuestionZoomComparison({
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
  const [percent, setPercent] = useState(100);
  const [color, setColor] = useState<AgentIconColor | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [useCopilotIcon, setUseCopilotIcon] = useState(true);
  const [useHarmonizedPalette, setUseHarmonizedPalette] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [conflicts, setConflicts] = useState(false);
  const [paused, setPaused] = useState(false);
  const previewAgent: QuestionAgentPresentation = color
    ? {
        kind: 'external',
        alias: 'Research Agent',
        icon: { shape: 'flower', color },
      }
    : agent;
  return (
    <section
      id="zoom-comparison"
      className="qzc-study"
      data-palette={useHarmonizedPalette ? 'harmonized' : 'theme'}
      aria-label="新卡片与头像环融合版缩放对照"
    >
      <header>
        <p>两套完整缩放提案 · 未应用到正式画布</p>
        <h2>简洁卡片，还是左侧色线？</h2>
        <p>
          保留 C 简洁卡片与 D
          左侧色线融合版，共享上方的状态、长标题和主题设置。拖动滑杆可检查连续变化；下面是五档与六种状态对照。历史设计稿保留在下方。
        </p>
      </header>
      <div className="qzc-controls">
        <label>
          连续缩放{' '}
          <RangeSlider
            label="两套方案连续缩放"
            min={1}
            max={100}
            value={percent}
            onChange={setPercent}
            showValue={false}
          />
          <output>{percent}%</output>
        </label>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={isOpen}
          onClick={() => setIsOpen((value) => !value)}
        >
          当前打开
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={useCopilotIcon}
          onClick={() => setUseCopilotIcon((value) => !value)}
        >
          Copilot 图标
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={useHarmonizedPalette}
          onClick={() => setUseHarmonizedPalette((value) => !value)}
        >
          {useHarmonizedPalette ? '配色：新版' : '配色：原主题'}
        </Button>
        <div role="group" aria-label="缩放方案 Agent 颜色">
          <Button
            size="sm"
            variant="outline"
            aria-pressed={color === null}
            onClick={() => setColor(null)}
          >
            跟随上方 Agent
          </Button>
          {AGENT_ICON_COLORS.map((value) => (
            <Button
              key={value}
              size="sm"
              variant="outline"
              aria-pressed={color === value}
              onClick={() => setColor(value)}
            >
              {COLOR_NAMES[value]} Agent
            </Button>
          ))}
        </div>
      </div>
      <p>
        配色按钮显示当前版本，点击切换。新版浅色模式保留四组主色，以蓝色为参照调整描边、背景和
        bg-hover
        的明暗层级；使用独立色值，不使用渐变。深色配色暂未统一，全局主题不变。
      </p>
      <div
        className="qzc-palette-preview"
        role="group"
        aria-label="状态配色层级对照"
      >
        {(
          [
            ['info', '蓝色'],
            ['warning', '橙色'],
            ['success', '绿色'],
            ['danger', '红色'],
          ] as const
        ).map(([tone, label]) => (
          <div
            key={tone}
            data-palette-tone={tone}
            style={
              {
                '--qzc-preview-light': `var(--${tone}-light)`,
                '--qzc-preview-bg': `var(--${tone}-bg)`,
                '--qzc-preview-bg-hover': `var(--${tone}-bg-hover)`,
              } as CSSProperties
            }
          >
            <h3>{label}</h3>
            <div className="qzc-palette-shades">
              {(
                [
                  ['', '主色'],
                  ['-light', '描边'],
                  ['-bg', '背景'],
                  ['-bg-hover', '悬停'],
                ] as const
              ).map(([suffix, name]) => (
                <span key={name}>
                  <i
                    aria-hidden
                    style={{ background: `var(--${tone}${suffix})` }}
                  />
                  {name}
                </span>
              ))}
            </div>
            <div className="qzc-palette-sample">
              移入查看 hover，描边保持不变
            </div>
          </div>
        ))}
      </div>
      <p>
        “当前打开”可与六种状态叠加：近景描边、浅底色和对话尾角跟随当前状态色，远景使用同色对话气泡，不叠加运行内圈；未打开时保持基础底色，待授权保留盾牌。此开关只模拟打开标记，不会把“待查看”自动改成“已查看”。
      </p>
      {(['adaptive', 'rail'] as const).map((direction) => (
        <section
          id={`zoom-${direction}`}
          className="qzc-direction"
          data-motion-paused={direction === 'adaptive' && paused}
          key={direction}
          aria-label={
            direction === 'adaptive'
              ? 'C 近景简洁远景头像环完整缩放'
              : 'D 左侧色线融合版完整缩放'
          }
        >
          <header>
            <h3>{DIRECTIONS[direction].title}</h3>
            <p>{DIRECTIONS[direction].description}</p>
          </header>
          {direction === 'adaptive' && (
            <div
              className="qzc-controls"
              role="group"
              aria-label="C 缩小态动画设置"
            >
              <Button
                size="sm"
                variant="outline"
                aria-pressed={reviewed}
                onClick={() => setReviewed(!reviewed)}
              >
                C：已查看
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={conflicts}
                onClick={() => setConflicts(!conflicts)}
              >
                C：有未解决冲突
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={paused}
                onClick={() => setPaused(!paused)}
              >
                C：暂停动画
              </Button>
              <span>
                拖到 25% 以下查看；打开对话停止一般提醒，待授权仍提醒。仅此
                Playground 生效。
              </span>
            </div>
          )}
          <div className="qzc-live" data-live={direction}>
            <QuestionZoomSpecimen
              direction={direction}
              zoom={percent / 100}
              reviewed={reviewed}
              conflictCount={conflicts ? 2 : 0}
              isOpen={isOpen}
              useCopilotIcon={useCopilotIcon}
              state={state}
              agent={previewAgent}
              title={title}
              onOpen={() => onOpen(state)}
            />
          </div>
          <div className="qzc-scales" aria-label="五档缩放">
            {SCALES.map((zoom) => (
              <div key={zoom}>
                <span>{zoom * 100}%</span>
                <QuestionZoomSpecimen
                  direction={direction}
                  zoom={zoom}
                  reviewed={reviewed}
                  conflictCount={conflicts ? 2 : 0}
                  state={state}
                  isOpen={isOpen}
                  useCopilotIcon={useCopilotIcon}
                  agent={previewAgent}
                  title={title}
                  onOpen={() => onOpen(state)}
                />
              </div>
            ))}
          </div>
          <details>
            <summary>展开六种状态 × 五档缩放</summary>
            <div className="qzc-matrix">
              {STATES.map((value) => (
                <section key={value}>
                  <h4>{value === 'unread' ? '待查看' : STATUS[value].label}</h4>
                  <div className="qzc-scales">
                    {SCALES.map((zoom) => (
                      <div key={zoom}>
                        <span>{zoom * 100}%</span>
                        <QuestionZoomSpecimen
                          direction={direction}
                          zoom={zoom}
                          reviewed={reviewed}
                          conflictCount={conflicts ? 2 : 0}
                          state={value}
                          isOpen={isOpen}
                          useCopilotIcon={useCopilotIcon}
                          agent={previewAgent}
                          title={title}
                          onOpen={() => onOpen(value)}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </details>
        </section>
      ))}
      <p className="qzc-note">
        卡片在固定的画布宽度下排版，高度随内容撑开；滑条只缩放整体，不触发重新换行或逐项隐藏。C、D
        复用 Note 的远景切换边界（低于 25% 进入、30%
        恢复）。所有形态都不设最小显示尺寸，点击只打开本地预览。
      </p>
    </section>
  );
}
