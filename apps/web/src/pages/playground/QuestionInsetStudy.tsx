// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Button } from '@/components/Common/Button';

import { STATUS } from './QuestionStatusZoomStudy';
import './QuestionInsetStudy.css';

import type { QuestionStudyState } from './QuestionStatusZoomStudy';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

const STATES: QuestionStudyState[] = [
  'draft',
  'running',
  'approval',
  'unread',
  'viewed',
  'error',
];
const SAMPLES: Partial<Record<QuestionStudyState, string>> = {
  running: '正在读取画布上的产品资料',
  approval: '请求访问产品网站的外部链接',
  unread: '建议按产品组织入口，帮助新用户找到适合的方案。',
  viewed: '建议按产品组织入口，帮助新用户找到适合的方案。',
  error: '产品网站的链接读取失败',
};

export type QuestionReferenceAppearance =
  | 'compact'
  | 'colored-inset'
  | 'gray-inset'
  | 'external'
  | 'tag'
  | 'notice'
  | 'compact-notice'
  | 'rounded-header'
  | 'divided-header';

export function InsetQuestionCard({
  state,
  agent,
  title,
  zoom = 1,
  showSample = false,
  appearance,
  attentionOnly = true,
  onOpen,
}: {
  state: QuestionStudyState;
  agent: QuestionAgentPresentation;
  title: string;
  zoom?: number;
  showSample?: boolean;
  appearance?: QuestionReferenceAppearance;
  attentionOnly?: boolean;
  onOpen: () => void;
}) {
  const { icon: Icon, label, tone } = STATUS[state];
  const width = (appearance === 'notice' ? 360 : 280) * zoom;
  const tiny = width < 100;
  const small = width < 220;
  const sample = showSample ? SAMPLES[state] : undefined;
  return (
    <article
      className="qi-card"
      data-state={state}
      data-appearance={appearance}
      data-emphasized={
        !attentionOnly || state === 'approval' || state === 'error'
      }
      data-tone={tone}
      data-size={tiny ? 'tiny' : small ? 'small' : 'full'}
      style={{ width: tiny ? 56 : width }}
      aria-label={`${label} · ${title}`}
      title={
        appearance === 'notice' ||
        appearance === 'compact-notice' ||
        appearance === 'compact'
          ? label
          : undefined
      }
    >
      <header className="qi-header">
        <span className="qi-agent">
          <AgentAvatarMark agent={agent} size={tiny ? 16 : 18} detail="full" />
          {!small ? <span>{agent.alias}</span> : null}
        </span>
        {appearance === 'compact-notice' ? (
          !tiny || state === 'running' ? (
            <span className="qi-status">
              {state === 'running' ? (
                <span className="qi-spin">
                  <Icon size={12} aria-hidden />
                </span>
              ) : null}
              {!tiny ? (
                <span className="qi-status-label">
                  {state === 'unread' ? '待查看' : label}
                </span>
              ) : null}
            </span>
          ) : null
        ) : appearance !== 'notice' ? (
          <span className="qi-status">
            <span className={state === 'running' ? 'qi-spin' : undefined}>
              <Icon size={tiny ? 14 : 12} aria-hidden />
            </span>
            {!small ? (
              <span>
                {appearance === 'compact' && state === 'unread'
                  ? '待查看'
                  : label}
              </span>
            ) : null}
          </span>
        ) : null}
      </header>
      {!tiny ? (
        <div className="qi-content">
          <div className="qi-question">
            <h3>{title}</h3>
          </div>
          {!small && sample ? (
            <div className="qi-detail">
              <span className="qi-sample-label">
                {state === 'unread' || state === 'viewed'
                  ? '回答样例'
                  : '活动样例'}
              </span>
              <p>{sample}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      <Button
        variant="ghost"
        className="qi-open"
        aria-label={`打开：${label} · ${title} · ${agent.alias}`}
        onClick={onOpen}
      >
        <span className="sr-only">打开对话</span>
      </Button>
    </article>
  );
}

export function QuestionInsetStudy({
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
  const [showSample, setShowSample] = useState(false);
  return (
    <section
      className="qi-study"
      id="inset-question-design"
      aria-label="内嵌面板设计稿"
    >
      <div className="qi-heading">
        <div>
          <span className="qi-kicker">当前设计稿 · 01</span>
          <h2>浅灰外壳，内容内嵌。</h2>
          <p>顶部看 Agent 和状态，里面看问题。只做这一种结构。</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={showSample}
          onClick={() => setShowSample(!showSample)}
        >
          活动 / 回答样例
        </Button>
      </div>
      <div className="qi-hero qi-canvas">
        <InsetQuestionCard
          state={state}
          agent={agent}
          title={title}
          showSample={showSample}
          onOpen={() => onOpen(state)}
        />
        <div className="qi-key">
          <span>系统中性底色与边框</span>
          <span>系统 surface 内层面板</span>
          <span>状态仅在右上角着色</span>
        </div>
      </div>
      <p className="qi-caption">
        点击卡片可打开本地交互预览。活动与回答样例默认关闭；没有真实信息时不补写进度或结果。
      </p>
      <h3 className="qi-section-title">同一外形，六种状态</h3>
      <div className="qi-matrix qi-canvas">
        {STATES.map((value) => (
          <div className="qi-case" key={value}>
            <InsetQuestionCard
              state={value}
              agent={agent}
              title={title}
              showSample={showSample}
              onOpen={() => onOpen(value)}
            />
          </div>
        ))}
      </div>
      <h3 className="qi-section-title">缩小后</h3>
      <div className="qi-scales qi-canvas">
        {[1, 0.75, 0.5, 0.25, 0.1].map((zoom) => (
          <div key={zoom}>
            <span className="qi-scale-label">{zoom * 100}%</span>
            <InsetQuestionCard
              state={state}
              agent={agent}
              title={title}
              zoom={zoom}
              showSample={showSample}
              onOpen={() => onOpen(state)}
            />
          </div>
        ))}
      </div>
      <p className="qi-caption">
        缩小时先收起详情和文字标签，保留问题与状态符号；更小时只保留 Agent +
        状态。这里采用最小 56 × 32px 的语义缩放示意，尚未验证密集画布布局。
      </p>
    </section>
  );
}
