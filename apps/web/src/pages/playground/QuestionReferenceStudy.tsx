// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Button } from '@/components/Common/Button';
import { RangeSlider } from '@/components/Common/RangeSlider';

import { STATUS } from './QuestionStatusZoomStudy';
import './QuestionReferenceStudy.css';

import type { QuestionStudyState } from './QuestionStatusZoomStudy';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

export const REFERENCE_VARIANTS = [
  {
    id: 'chip',
    name: '右上角状态标签',
    note: '最接近参考图第一行：身份、状态、问题，各在自己的位置。',
  },
  {
    id: 'edge',
    name: '状态标签 + 顶部细线',
    note: '只增加一条 2px 状态线，让状态更易扫到，不改变卡片形状。',
  },
  {
    id: 'activity',
    name: '问题 + 一行活动',
    note: '同样的外形，多留一行给真实活动或结果；没有信息时不虚构进度。',
  },
] as const;
type Variant = (typeof REFERENCE_VARIANTS)[number]['id'];

const CASES: QuestionStudyState[] = [
  'draft',
  'running',
  'approval',
  'unread',
  'error',
];
const LABELS: Record<QuestionStudyState, string> = {
  draft: '待开始',
  running: '进行中',
  approval: '等你授权',
  unread: '本轮结束',
  viewed: '已查看',
  error: '出错',
};
const DETAILS: Record<QuestionStudyState, string> = {
  draft: '打开对话开始',
  running: '查看当前运行',
  approval: '有待处理的权限请求',
  unread: '本轮结果尚未查看',
  viewed: '本轮结果已查看',
  error: '打开对话查看原因',
};
const EXAMPLES: Record<QuestionStudyState, string> = {
  draft: '尚无活动信息',
  running: '正在读取产品资料',
  approval: '请求访问外部链接',
  unread: '建议按产品组织网站入口',
  viewed: '建议按产品组织网站入口',
  error: '外部链接读取失败',
};

export function ReferenceQuestionCard({
  variant,
  state,
  agent,
  title,
  zoom = 1,
  examples = false,
  onOpen,
}: {
  variant: Variant;
  state: QuestionStudyState;
  agent: QuestionAgentPresentation;
  title: string;
  zoom?: number;
  examples?: boolean;
  onOpen: () => void;
}) {
  const info = STATUS[state];
  const Icon = info.icon;
  const width = 224 * zoom;
  const compact = width < 100;
  const medium = !compact && width < 190;
  // Shared screen-space fallback for all three treatments, not a new shape per variant.
  const height = compact ? 30 : medium ? 58 : variant === 'activity' ? 96 : 76;
  return (
    <article
      className="qr-card"
      data-variant={variant}
      data-state={state}
      data-tone={info.tone}
      data-size={compact ? 'mark' : medium ? 'small' : 'full'}
      style={{ width: compact ? 46 : width, height }}
      aria-label={`${title} · ${LABELS[state]}`}
    >
      {compact ? (
        <div className="qr-minimal" aria-hidden>
          <AgentAvatarMark agent={agent} size={16} detail="full" />
          <Icon
            className={state === 'running' ? 'qr-spinning' : undefined}
            size={14}
          />
        </div>
      ) : (
        <>
          <header className="qr-header">
            <span className="qr-identity">
              <AgentAvatarMark
                agent={agent}
                size={medium ? 16 : 18}
                detail="full"
              />
              {!medium ? <span title={agent.alias}>{agent.alias}</span> : null}
            </span>
            <span className="qr-state">
              <Icon
                aria-hidden
                size={12}
                className={state === 'running' ? 'qr-spinning' : undefined}
              />
              {!medium ? LABELS[state] : null}
            </span>
          </header>
          <h3 title={title}>{title}</h3>
          {variant === 'activity' && !medium ? (
            <p className="qr-detail">
              {examples ? (
                <>
                  <span>示例 · </span>
                  {EXAMPLES[state]}
                </>
              ) : (
                DETAILS[state]
              )}
            </p>
          ) : null}
        </>
      )}
      <Button
        variant="ghost"
        className="qr-open"
        aria-label={`打开：${title} · ${LABELS[state]} · ${agent.alias}`}
        onClick={onOpen}
      >
        <span className="sr-only">打开对话</span>
      </Button>
    </article>
  );
}

export function QuestionReferenceStudy({
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
  const [zoom, setZoom] = useState(100);
  const [examples, setExamples] = useState(false);
  return (
    <section
      className="qr-study"
      id="reference-question-design"
      aria-label="参考图方向"
    >
      <header className="qr-intro">
        <h2>同一张紧凑卡片，只比较信息的表达。</h2>
        <p>
          回到参考图的比例：轻底色、小头像、两行内容。没有侧栏、切角、气泡尾巴或多余的操作区。
        </p>
      </header>
      {REFERENCE_VARIANTS.map((variant, index) => (
        <section className="qr-row" key={variant.id} aria-label={variant.name}>
          <header className="qr-row-title">
            <span>0{index + 1}</span>
            <h3>{variant.name}</h3>
          </header>
          <div className="qr-scroll">
            <div className="qr-board">
              {CASES.map((value) => (
                <div key={value} className="qr-case">
                  <p className="qr-case-label" data-tone={STATUS[value].tone}>
                    <span />
                    {LABELS[value]}
                  </p>
                  <ReferenceQuestionCard
                    variant={variant.id}
                    state={value}
                    agent={agent}
                    title={title}
                    examples={examples}
                    onOpen={() => onOpen(value)}
                  />
                </div>
              ))}
            </div>
          </div>
          <p className="qr-note">{variant.note}</p>
        </section>
      ))}
      <div className="qr-example-control">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={examples}
          onClick={() => setExamples(!examples)}
        >
          显示活动文案样例
        </Button>
        <span>
          仅第三行；示例明确标注，不代表已接入实时数据。状态线不是进度条。
        </span>
      </div>
      <section className="qr-zoom" aria-label="紧凑卡片缩小对照">
        <header className="qr-row-title">
          <h3>缩小后的状态，单独看</h3>
        </header>
        <div className="qr-zoom-controls">
          <RangeSlider
            label="参考方案缩放"
            value={zoom}
            min={10}
            max={100}
            onChange={setZoom}
            showValue={false}
          />
          <span>{zoom}%</span>
          {[100, 75, 50, 25, 10].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={zoom === value ? 'solid' : 'outline'}
              onClick={() => setZoom(value)}
              aria-pressed={zoom === value}
            >
              {value}%
            </Button>
          ))}
        </div>
        <div className="qr-zoom-board">
          {REFERENCE_VARIANTS.map((variant) => (
            <div className="qr-zoom-case" key={variant.id}>
              <span>{variant.name}</span>
              <div>
                <ReferenceQuestionCard
                  variant={variant.id}
                  state={state}
                  agent={agent}
                  title={title}
                  zoom={zoom / 100}
                  examples={examples}
                  onOpen={() => onOpen(state)}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="qr-note">
          这里是语义缩放实验，不是等比例截图：空间不够时先去掉活动行与状态文字，保留问题和状态符号；再缩小时只留
          Agent + 状态符号。最小标记 46 ×
          30px，可能超出原始范围，密集布局仍待验证。
        </p>
        <div className="qr-tiny-board">
          {([...CASES, 'viewed'] as QuestionStudyState[]).map((value) => (
            <div key={value}>
              <ReferenceQuestionCard
                variant="chip"
                state={value}
                agent={agent}
                title={title}
                zoom={0.1}
                onOpen={() => onOpen(value)}
              />
              <span>{LABELS[value]}</span>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
