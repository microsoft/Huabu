// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { Button } from '@/components/Common/Button';

import { InsetQuestionCard } from './QuestionInsetStudy';
import { STATUS } from './QuestionStatusZoomStudy';
import './QuestionReferenceGallery.css';

import type { QuestionReferenceAppearance } from './QuestionInsetStudy';
import type { QuestionStudyState } from './QuestionStatusZoomStudy';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

export const QUESTION_REFERENCES = [
  {
    id: 'compact',
    name: '紧凑对话卡',
    source: '最早的 A2 状态卡参考',
    description: '两行信息：Agent 与状态在上，问题在下；不套内框。',
  },
  {
    id: 'colored-inset',
    name: '有色外壳',
    source: 'Trigger / Inbound shipment',
    description:
      '固定 Question 色外壳，内嵌内容面板；颜色表示类型，不随状态变化。',
  },
  {
    id: 'gray-inset',
    name: '浅灰内嵌',
    source: 'Conversation / Salesforce tool',
    description: '中性顶栏与外壳，独立白色内容面板；保留上一版作对照。',
  },
  {
    id: 'external',
    name: '外置状态',
    source: 'PayPal Payment / 外置 Trigger',
    description: '状态放右上方外侧，问题在上，Agent 移到下方；不重复内置状态。',
  },
  {
    id: 'tag',
    name: '柔和状态标签',
    source: 'Tags / Pending / In progress',
    description: '白色单层卡片，圆角状态标签承担强调；不再给容器着色。',
  },
  {
    id: 'notice',
    name: '问题优先 · 状态色线',
    source: '第二张 / Did you know? 白底通知',
    description:
      '问题作为主文字，状态只映射到左侧细色线；保留 Agent 身份，不再单列状态标题或图标。',
  },
  {
    id: 'rounded-header',
    name: '内嵌圆角色带',
    source: 'Patient Tracking Summary',
    description:
      '白色卡片内留一圈空隙，圆角色带承载 Agent 与状态，不再套状态胶囊。',
  },
  {
    id: 'divided-header',
    name: '平直分区顶栏',
    source: 'Bug Tracking Summary',
    description:
      '状态顶栏铺满卡片宽度，下方用细线分隔问题；不额外添加重复色点。',
  },
] as const satisfies ReadonlyArray<{
  id: QuestionReferenceAppearance;
  name: string;
  source: string;
  description: string;
}>;

export function QuestionReferenceGallery({
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
  const [zoom, setZoom] = useState(1);
  const [samples, setSamples] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(true);
  return (
    <section
      className="qg-gallery"
      id="reference-gallery"
      aria-label="八版参考图设计对照"
    >
      <header className="qg-intro">
        <h2>八张参考，八种表达</h2>
        <p>
          同一问题、同一 Agent、同一状态。每版标注对应参考，不预选最终方案。
        </p>
      </header>
      <div className="qg-controls">
        <div role="group" aria-label="参考对照缩放">
          {[1, 0.75, 0.5, 0.25, 0.1].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={zoom === value ? 'solid' : 'outline'}
              aria-pressed={zoom === value}
              onClick={() => setZoom(value)}
            >
              {value * 100}%
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={samples}
          onClick={() => setSamples(!samples)}
        >
          活动 / 回答样例
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly(!attentionOnly)}
        >
          仅需介入时强调大色块
        </Button>
      </div>
      <p className="qg-help">
        大色块开关仅作用于
        07–08：默认只强调授权与错误；关闭后比较各状态着色。01–06
        保留各自配色规则。样例默认关闭，无虚构进度。
      </p>
      <section
        className="qg-notice-focus"
        id="notice-reference"
        aria-label="01 与 06 融合稿"
      >
        <header>
          <span>融合稿 · 01 × 06</span>
          <h3>紧凑布局，轻量状态。</h3>
          <p>
            上方保留 Agent
            与小号状态文字，下方突出问题；状态文字与左侧色线同色，不加底色。原版保留在下方对照。
          </p>
        </header>
        <div className="qg-notice-preview">
          <InsetQuestionCard
            appearance="compact-notice"
            state={state}
            agent={agent}
            title={title}
            zoom={zoom}
            showSample={samples}
            onOpen={() => onOpen(state)}
          />
        </div>
        <section className="qg-hybrid-states" aria-label="融合版六种状态">
          <h4>六种状态 · 并排对照</h4>
          <div className="qg-hybrid-state-grid">
            {(Object.keys(STATUS) as QuestionStudyState[]).map((value) => (
              <div className="qg-state-case" key={value}>
                <InsetQuestionCard
                  appearance="compact-notice"
                  state={value}
                  agent={agent}
                  title={title}
                  showSample={samples}
                  onOpen={() => onOpen(value)}
                />
              </div>
            ))}
          </div>
        </section>
        <section className="qg-hybrid-scales" aria-label="融合版进行中缩放对照">
          <h4>进行中 · 缩放对照</h4>
          <p>
            语义缩放：75% / 50% 收起 Agent 名称，保留状态文字与
            loading，长状态按可用空间省略。25% 与 10%
            才收起问题和状态文字，均使用 56 × 32px 最小标记，不是等比例截图。
          </p>
          <div className="qg-hybrid-scale-grid">
            {[1, 0.75, 0.5, 0.25, 0.1].map((value) => (
              <div className="qg-hybrid-scale-case" key={value}>
                <span>{value * 100}%</span>
                <InsetQuestionCard
                  appearance="compact-notice"
                  state="running"
                  agent={agent}
                  title={title}
                  zoom={value}
                  showSample={samples}
                  onOpen={() => onOpen('running')}
                />
              </div>
            ))}
          </div>
        </section>
      </section>
      <div className="qg-grid">
        {QUESTION_REFERENCES.map((reference, index) => (
          <section
            className="qg-proposal"
            key={reference.id}
            aria-label={`${String(index + 1).padStart(2, '0')} ${reference.name}`}
          >
            <header className="qg-proposal-heading">
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{reference.name}</h3>
                <p>参考：{reference.source}</p>
              </div>
            </header>
            <div className="qg-stage">
              <InsetQuestionCard
                appearance={reference.id}
                state={state}
                agent={agent}
                title={title}
                zoom={zoom}
                showSample={samples}
                attentionOnly={attentionOnly}
                onOpen={() => onOpen(state)}
              />
            </div>
            <p className="qg-description">{reference.description}</p>
            <details className="qg-states">
              <summary>展开六种状态</summary>
              <div>
                {(Object.keys(STATUS) as QuestionStudyState[]).map((value) => (
                  <div className="qg-state-case" key={value}>
                    <InsetQuestionCard
                      appearance={reference.id}
                      state={value}
                      agent={agent}
                      title={title}
                      showSample={samples}
                      attentionOnly={attentionOnly}
                      onOpen={() => onOpen(value)}
                    />
                  </div>
                ))}
              </div>
            </details>
          </section>
        ))}
      </div>
      <p className="qg-help">
        所有颜色直接复用系统
        token；未加光晕或新的装饰图标。缩小是语义缩放：先收起详情和文字标签，再收起问题，最小标记为
        56 ×
        32px。外置状态需要额外上方空间，密集画布中的碰撞尚未验证。点击卡片只打开本地预览。
      </p>
    </section>
  );
}
