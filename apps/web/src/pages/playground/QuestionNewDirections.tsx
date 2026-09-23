// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowUpRight, MessageSquare } from 'lucide-react';
import { useState } from 'react';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Button } from '@/components/Common/Button';
import { RangeSlider } from '@/components/Common/RangeSlider';

import { STATUS } from './QuestionStatusZoomStudy';
import './QuestionNewDirections.css';

import type { QuestionStudyState } from './QuestionStatusZoomStudy';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

export const QUESTION_DIRECTIONS = [
  {
    id: 'rail',
    code: 'A',
    title: '状态侧栏',
    subtitle: '让状态成为结构，而不是一个角标。',
    description:
      '左侧独立状态区，右侧承载问题。缩小时保留竖向状态块，不退回头像圆环。',
    tradeoff: '扫描状态最快；侧栏会占用一部分标题宽度。',
  },
  {
    id: 'ticket',
    code: 'B',
    title: '任务票签',
    subtitle: '像一张正在处理的工作票。',
    description:
      '突出顶部状态票头，用切角与虚线区分 Note。缩小时保留带切角的状态票签。',
    tradeoff: '状态文字最突出；整体更像任务，而不是聊天。',
  },
  {
    id: 'bubble',
    code: 'C',
    title: '对话气泡',
    subtitle: '直接用形状表达“这是一段对话”。',
    description:
      '圆角气泡与尾部是稳定身份，状态位于右上。Agent 是底部的参与者，不是状态本身。',
    tradeoff: '与笔记最容易区分；气泡比普通卡片更有视觉个性。',
  },
] as const;

type Direction = (typeof QUESTION_DIRECTIONS)[number]['id'];

export function newQuestionLayout(zoom: number) {
  const width = 320 * zoom;
  return {
    width,
    height: 200 * zoom,
    showTitle: width >= 128,
    showWords: width >= 160,
    showDetail: width >= 288,
    compact: width < 128,
  };
}

export function NewQuestionSpecimen({
  direction,
  state,
  agent,
  title,
  zoom,
  showExample = false,
  onOpen,
}: {
  direction: Direction;
  state: QuestionStudyState;
  agent: QuestionAgentPresentation;
  title: string;
  zoom: number;
  showExample?: boolean;
  onOpen: () => void;
}) {
  const layout = newQuestionLayout(zoom);
  const info = STATUS[state];
  const Icon = info.icon;
  const label = `${info.label} · ${title} · ${agent.alias}`;
  return (
    <div
      className="qn-footprint"
      style={{ width: layout.width, height: layout.height }}
    >
      <article
        className="qn-node"
        data-direction={direction}
        data-state={state}
        data-tone={info.tone}
        data-compact={layout.compact}
        data-detail={layout.showDetail}
        aria-label={label}
        style={{
          width: layout.compact ? 38 : layout.width,
          height: layout.compact ? 38 : layout.height,
        }}
      >
        <div className="qn-status-zone" aria-hidden>
          <Icon className={state === 'running' ? 'qn-working' : undefined} />
          {layout.showWords ? <span>{info.label}</span> : null}
        </div>
        {layout.showTitle ? (
          <div className="qn-main-content">
            {layout.showDetail ? (
              <span className="qn-kind">
                {direction === 'ticket' ? 'QUESTION / 对话任务' : '用户的问题'}
              </span>
            ) : null}
            <h3 title={title}>{title}</h3>
            {layout.showDetail && showExample ? (
              <p className="qn-ai-example">
                <span>AI 信息示例 · 非实时</span>
                {state === 'running'
                  ? '正在读取画布上的产品资料。'
                  : state === 'approval'
                    ? '请求访问资料中的外部链接。'
                    : state === 'unread' || state === 'viewed'
                      ? '建议按产品划分入口，再组织使用指南。'
                      : state === 'error'
                        ? '示例：资料链接读取失败。'
                        : '尚未开始对话。'}
              </p>
            ) : null}
          </div>
        ) : null}
        {layout.showDetail ? (
          <footer className="qn-identity">
            <span className="qn-avatar">
              <AgentAvatarMark agent={agent} size={20} detail="full" />
            </span>
            <span>{agent.alias}</span>
            <MessageSquare size={13} aria-hidden />
          </footer>
        ) : null}
        <Button
          variant="ghost"
          className="qn-open"
          aria-label={`打开：${label}`}
          onClick={onOpen}
          title={layout.compact ? label : undefined}
        >
          <span className="sr-only">打开对话</span>
        </Button>
        {layout.showDetail ? (
          <ArrowUpRight className="qn-open-hint" size={14} aria-hidden />
        ) : null}
      </article>
    </div>
  );
}

export function QuestionNewDirections({
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
  const [showExample, setShowExample] = useState(false);
  return (
    <section
      className="qn-study"
      id="new-question-directions"
      aria-label="三版全新设计"
    >
      <header className="qd-section-header">
        <div>
          <p className="qd-eyebrow">NEW DIRECTIONS / 三版新探索</p>
          <h2>不再围绕头像做状态，而是让节点本身表达状态。</h2>
        </div>
      </header>
      <p className="qn-lead">
        共同原则：状态 ＞ 用户的问题 ＞ AI
        信息。三版是平行候选，尚未选定最终方案；没有复用旧版状态环、发光或头像接管。
      </p>
      <div className="qs-controls">
        <span>预览缩放 {zoom}%</span>
        <RangeSlider
          label="新方案缩放"
          value={zoom}
          min={10}
          max={100}
          onChange={setZoom}
          showValue={false}
        />
        {[100, 75, 50, 25, 10].map((value) => (
          <Button
            key={value}
            variant={zoom === value ? 'solid' : 'outline'}
            size="sm"
            aria-pressed={zoom === value}
            onClick={() => setZoom(value)}
          >
            {value}%
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          aria-pressed={showExample}
          onClick={() => setShowExample(!showExample)}
        >
          AI 信息样例
        </Button>
      </div>
      <div className="qn-directions">
        {QUESTION_DIRECTIONS.map((direction) => (
          <section
            className="qn-direction"
            key={direction.id}
            aria-label={`${direction.code} ${direction.title}`}
          >
            <header className="qn-direction-title">
              <span>{direction.code}</span>
              <div>
                <h3>{direction.title}</h3>
                <p>{direction.subtitle}</p>
              </div>
            </header>
            <div className="qn-stage qd-grid-surface">
              <NewQuestionSpecimen
                direction={direction.id}
                state={state}
                agent={agent}
                title={title}
                zoom={zoom / 100}
                showExample={showExample}
                onOpen={() => onOpen(state)}
              />
            </div>
            <p className="qn-description">{direction.description}</p>
            <div className="qn-size-comparison">
              {[0.5, 0.25, 0.1].map((value) => (
                <div key={value}>
                  <span>{value * 100}%</span>
                  <div className="qn-size-stage">
                    <NewQuestionSpecimen
                      direction={direction.id}
                      state={state}
                      agent={agent}
                      title={title}
                      zoom={value}
                      onOpen={() => onOpen(state)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="qn-tradeoff">{direction.tradeoff}</p>
          </section>
        ))}
      </div>
      <header className="qd-section-header qn-matrix-heading">
        <div>
          <p className="qd-eyebrow">SMALL, BUT NOT SILENT</p>
          <h2>缩到 10% 后，三种轮廓还在。</h2>
        </div>
      </header>
      <p className="qn-lead">
        这里比较状态符号，而不是小字。文字是图例；Agent
        图标在空间不足时让位给状态。
      </p>
      <div className="qn-state-matrix">
        {QUESTION_DIRECTIONS.map((direction) => (
          <section
            key={direction.id}
            className="qn-state-family"
            aria-label={`${direction.title}小尺寸状态`}
          >
            <h3>
              {direction.code} · {direction.title}
            </h3>
            <div className="qn-state-grid qd-grid-surface">
              {(Object.keys(STATUS) as QuestionStudyState[]).map((value) => (
                <div key={value}>
                  <div className="qn-state-stage">
                    <NewQuestionSpecimen
                      direction={direction.id}
                      state={value}
                      agent={agent}
                      title={title}
                      zoom={0.1}
                      onOpen={() => onOpen(value)}
                    />
                  </div>
                  <span>{STATUS[value].label}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="qn-footnote">
        状态符号保持至少 16px，极小尺寸保留 38px
        的可点击形状，可能超出原始节点范围；这是待验证的设计取舍，不是已解决的密集画布布局。无进度百分比、无默认回复摘要、无真实
        Agent 调用。
      </p>
    </section>
  );
}
