// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileText,
  GitCompareArrows,
  LoaderCircle,
  MessageCircle,
  Moon,
  Pencil,
  ShieldQuestion,
  Sun,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark';
import { Button } from '@/components/Common/Button';
import { nodeBoundaryForAccent } from '@/components/Nodes/design/nodeBoundary';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { NODE_CONTENT_SPACING } from '@/components/Nodes/design/nodeSpacing';
import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { noteSurfaceStyle } from '@/components/Nodes/note/noteDesign';

import './QuestionDesignPlaygroundPage.css';

import { QuestionInsetStudy } from './QuestionInsetStudy';
import { QuestionNewDirections } from './QuestionNewDirections';
import { QuestionReferenceGallery } from './QuestionReferenceGallery';
import { QuestionReferenceStudy } from './QuestionReferenceStudy';
import { QuestionStatusZoomStudy } from './QuestionStatusZoomStudy';
import { QuestionZoomComparison } from './QuestionZoomComparison';

import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';

type DemoState =
  | 'draft'
  | 'running'
  | 'approval'
  | 'unread'
  | 'viewed'
  | 'error';
type Direction = 'topic' | 'handoff' | 'compact';

const STATES: Record<
  DemoState,
  {
    label: string;
    tone: string;
    icon: LucideIcon;
    detail: string;
    owner: string;
    action: string;
  }
> = {
  draft: {
    label: '待开始',
    tone: 'neutral',
    icon: Pencil,
    detail: '当前没有运行状态，可打开对话。',
    owner: '由你发起',
    action: '打开对话',
  },
  running: {
    label: '进行中',
    tone: 'info',
    icon: LoaderCircle,
    detail: '本轮标记为运行中，详情见对话。',
    owner: 'Agent 处理中',
    action: '查看对话',
  },
  approval: {
    label: '等你授权',
    tone: 'warning',
    icon: ShieldQuestion,
    detail: '有待处理的权限请求。',
    owner: '需要你介入',
    action: '查看请求',
  },
  unread: {
    label: '本轮结束',
    tone: 'neutral',
    icon: MessageCircle,
    detail: '本轮已结束，结果尚未查看。',
    owner: '等你查看',
    action: '查看对话',
  },
  viewed: {
    label: '已查看',
    tone: 'neutral',
    icon: Check,
    detail: '本轮结果已标记为查看。',
    owner: '随时继续',
    action: '继续对话',
  },
  error: {
    label: '运行出错',
    tone: 'danger',
    icon: CircleAlert,
    detail: '本轮运行出错，详情见对话。',
    owner: '查看错误',
    action: '查看原因',
  },
};

const DIRECTIONS: {
  id: Direction;
  number: string;
  title: string;
  summary: string;
  tradeoff: string;
}[] = [
  {
    id: 'topic',
    number: '01',
    title: '主题卡片',
    summary: '主题优先，状态清楚但不抢眼。',
    tradeoff: '最接近 Note 和内容卡片；常态安静，适合多数对话。',
  },
  {
    id: 'handoff',
    number: '02',
    title: '协作卡片',
    summary: '把“现在轮到谁”放在明处。',
    tradeoff: '需要介入时更明确；信息量较大，适合持续协作。',
  },
  {
    id: 'compact',
    number: '03',
    title: '紧凑对话条',
    summary: '左侧是对话身份，右上角是运行状态。',
    tradeoff:
      '固定“对话”标识与气泡头像，不靠底色区别于 Note；详细内容留在对话中。',
  },
];

const AGENTS: QuestionAgentPresentation[] = [
  { kind: 'internal', alias: 'Huabu', mode: 'operate' },
  {
    kind: 'external',
    alias: 'Research Agent',
    icon: { shape: 'flower', color: 'blue' },
  },
];

const TOPIC = '按产品整理网站内容框架';
const LONG_TOPIC =
  '梳理产品网站的信息架构，比较现有页面并提出适合新用户的内容组织方案';
const PROMPT = '参考画布上的产品资料，帮我整理网站的内容结构。';
const shellStyle: CSSProperties = {
  ...noteSurfaceStyle(null),
  ...nodeBoundaryForAccent(null),
  borderRadius: nodeMetricsForSize(400, 240).radius,
  '--qd-padding': `${NODE_CONTENT_SPACING.padding}px`,
  '--qd-gap': `${NODE_CONTENT_SPACING.descriptionGap}px`,
  '--qd-title-size': `${NODE_TYPOGRAPHY.cardTitle.size}px`,
  '--qd-title-weight': NODE_TYPOGRAPHY.cardTitle.weight,
} as CSSProperties;

function StateLabel({ state }: { state: DemoState }) {
  const { icon: Icon, label, tone } = STATES[state];
  return (
    <span className="qd-status" data-tone={tone}>
      <Icon
        aria-hidden
        size={14}
        className={state === 'running' ? 'qd-spinner' : undefined}
      />
      {label}
    </span>
  );
}

function Avatar({ agent }: { agent: QuestionAgentPresentation }) {
  return (
    <span className="qd-avatar" aria-label={`Agent: ${agent.alias}`}>
      <AgentAvatarMark agent={agent} size={28} detail="full" />
    </span>
  );
}

export function QuestionDesignCard({
  direction,
  state,
  agent = AGENTS[0],
  title = TOPIC,
  overview = false,
  onOpen,
}: {
  direction: Direction;
  state: DemoState;
  agent?: QuestionAgentPresentation;
  title?: string;
  overview?: boolean;
  onOpen: () => void;
}) {
  const info = STATES[state];
  const attention = state === 'approval' || state === 'error';
  return (
    <article
      className="qd-card"
      style={shellStyle}
      data-direction={direction}
      data-state={state}
      data-overview={overview}
      data-attention={attention}
      aria-label={`${title} · ${info.label}`}
    >
      {direction === 'compact' ? (
        <>
          <header className="qd-compact-heading">
            <Avatar agent={agent} />
            <span className="qd-agent-name" title={`对话 · ${agent.alias}`}>
              对话 · {agent.alias}
            </span>
            <StateLabel state={state} />
            <h3 title={title}>{title}</h3>
          </header>
          <div className="qd-compact-bottom">
            <Button variant="ghost" size="sm" onClick={onOpen}>
              <MessageCircle aria-hidden />
              {state === 'approval' ? '查看授权请求' : '打开对话'}
              <ArrowUpRight aria-hidden />
            </Button>
          </div>
        </>
      ) : overview ? (
        <>
          <div className="qd-overview-heading">
            <Avatar agent={agent} />
            <h3 title={title}>{title}</h3>
          </div>
          <div className="qd-overview-bottom">
            <StateLabel state={state} />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${info.action}：${title}`}
              onClick={onOpen}
            >
              <ArrowUpRight aria-hidden />
              打开
            </Button>
          </div>
        </>
      ) : (
        <>
          <header className="qd-card-header">
            <div className="qd-identity">
              <Avatar agent={agent} />
              <span>{agent.alias}</span>
            </div>
            <StateLabel state={state} />
          </header>
          <h3 title={title}>{title}</h3>
          <p className="qd-prompt">{PROMPT}</p>
          {direction === 'handoff' ? (
            <div className="qd-handoff" data-tone={info.tone}>
              <span className="qd-owner">{info.owner}</span>
              <p>{info.detail}</p>
              <Button
                variant={attention ? 'outline' : 'ghost'}
                tone={
                  state === 'approval'
                    ? 'warning'
                    : state === 'error'
                      ? 'danger'
                      : 'neutral'
                }
                size="sm"
                onClick={onOpen}
              >
                {info.action}
                <ArrowUpRight aria-hidden />
              </Button>
            </div>
          ) : (
            <footer className="qd-card-footer">
              <span className="qd-footer-detail">{info.detail}</span>
              <Button variant="ghost" size="sm" onClick={onOpen}>
                {info.action}
                <ArrowUpRight aria-hidden />
              </Button>
            </footer>
          )}
        </>
      )}
    </article>
  );
}

export default function QuestionDesignPlaygroundPage() {
  const [state, setState] = useState<DemoState>('approval');
  const [matrixDirection, setMatrixDirection] = useState<Direction>('compact');
  const [dark, setDark] = useState(false);
  const [external, setExternal] = useState(false);
  const [longTitle, setLongTitle] = useState(false);
  const [overview, setOverview] = useState(false);
  const [preview, setPreview] = useState<{
    state: DemoState;
    direction: Direction;
  } | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const agent = AGENTS[external ? 1 : 0];
  const title = longTitle ? LONG_TOPIC : TOPIC;

  function openPreview(nextState: DemoState, direction: Direction) {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPreview({ state: nextState, direction });
    // The preview is always mounted, so focus does not depend on a timer.
    previewRef.current?.focus();
    previewRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }

  function closePreview() {
    setPreview(null);
    returnFocus.current?.focus();
  }

  return (
    <div className={`qd-page ${dark ? 'dark' : ''}`}>
      <div className="qd-page-surface">
        <header className="qd-page-header">
          <a href="/playground/agent-nodes">← Agent playground</a>
          <span>QUESTION NODE / DESIGN STUDY</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDark(!dark)}
            aria-pressed={dark}
          >
            {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
            {dark ? '浅色预览' : '深色预览'}
          </Button>
        </header>
        <main className="qd-main">
          <section className="qd-intro">
            <div>
              <p className="qd-eyebrow">对话，不只是一个问题。</p>
              <h1>Question 节点 · 参考图对照</h1>
            </div>
            <div className="qd-intro-note">
              <p>保留 Agent 的身份，让主题、进展和介入请求各有位置。</p>
              <p>
                按你给的参考分别做八版，统一内容与系统配色。此前单版探索已折叠。
              </p>
              <a href="/playground/design">对照其他节点的设计 ↗</a>
            </div>
          </section>

          <section className="qd-controls" aria-label="设计预览设置">
            <div className="qd-control-row">
              <span className="qd-control-label">对话状态</span>
              <div className="qd-options" role="group" aria-label="对话状态">
                {(Object.keys(STATES) as DemoState[]).map((value) => (
                  <Button
                    key={value}
                    variant={state === value ? 'solid' : 'ghost'}
                    size="sm"
                    aria-pressed={state === value}
                    onClick={() => setState(value)}
                  >
                    {STATES[value].label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="qd-control-row">
              <span className="qd-control-label">预览选项</span>
              <div className="qd-options">
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={external}
                  onClick={() => setExternal(!external)}
                >
                  外部 Agent 图标
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={longTitle}
                  onClick={() => setLongTitle(!longTitle)}
                >
                  长标题
                </Button>
              </div>
              <span className="qd-control-hint">下方提供五档缩小对照。</span>
            </div>
          </section>

          <QuestionZoomComparison
            state={state}
            agent={agent}
            title={title}
            onOpen={(value) => openPreview(value, 'compact')}
          />

          <QuestionReferenceGallery
            state={state}
            agent={agent}
            title={title}
            onOpen={(value) => openPreview(value, 'compact')}
          />

          <details className="qs-history">
            <summary>上一版：浅灰内嵌面板</summary>
            <QuestionInsetStudy
              state={state}
              agent={agent}
              title={title}
              onOpen={(value) => openPreview(value, 'compact')}
            />
          </details>

          <details className="qs-history">
            <summary>上一版：紧凑卡片三种处理</summary>
            <QuestionReferenceStudy
              state={state}
              agent={agent}
              title={title}
              onOpen={(value) => openPreview(value, 'compact')}
            />
          </details>

          <details className="qs-history">
            <summary>已弃用探索：侧栏 / 票签 / 气泡</summary>
            <QuestionNewDirections
              state={state}
              agent={agent}
              title={title}
              onOpen={(value) => openPreview(value, 'compact')}
            />
          </details>

          <details className="qs-history">
            <summary>上一版：头像状态环（仅供历史对照）</summary>
            <QuestionStatusZoomStudy
              state={state}
              agent={agent}
              title={title}
              onOpen={(value) => openPreview(value, 'compact')}
            />
          </details>

          <details className="qs-history">
            <summary>历史方案对照（不是当前方案）</summary>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={overview}
              onClick={() => setOverview(!overview)}
            >
              旧版概览形态
            </Button>
            <section className="qd-directions" aria-label="三种设计方向">
              {DIRECTIONS.map((direction) => (
                <section
                  className="qd-direction"
                  key={direction.id}
                  aria-label={direction.title}
                >
                  <header className="qd-direction-header">
                    <span className="qd-number">{direction.number}</span>
                    <h2>{direction.title}</h2>
                    {direction.id === 'compact' ? (
                      <span className="qd-recommended">上一版</span>
                    ) : null}
                  </header>
                  <p className="qd-direction-summary">{direction.summary}</p>
                  <div className="qd-stage">
                    <QuestionDesignCard
                      direction={direction.id}
                      state={state}
                      agent={agent}
                      title={title}
                      overview={overview}
                      onOpen={() => openPreview(state, direction.id)}
                    />
                  </div>
                  <p className="qd-tradeoff">{direction.tradeoff}</p>
                </section>
              ))}
            </section>
          </details>

          <section
            ref={previewRef}
            tabIndex={-1}
            className="qd-preview"
            data-open={preview !== null}
            aria-label="本地对话预览"
          >
            {preview ? (
              <>
                <header>
                  <div>
                    <span className="qd-eyebrow">
                      LOCAL PREVIEW · 不会执行真实操作
                    </span>
                    <h2>{title}</h2>
                  </div>
                  <Button
                    iconOnly
                    variant="ghost"
                    title="关闭预览"
                    onClick={closePreview}
                  >
                    <X />
                  </Button>
                </header>
                <div className="qd-preview-content">
                  <StateLabel state={preview.state} />
                  <p>{STATES[preview.state].detail}</p>
                  {preview.state === 'approval' ? (
                    <div className="qd-request">
                      <ShieldQuestion aria-hidden />
                      <div>
                        <strong>示例权限请求：允许访问外部链接？</strong>
                        <p>
                          真实产品应在对话里展示操作内容与影响，不能把“打开请求”当作同意。
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {preview.state === 'unread' || preview.state === 'viewed' ? (
                    <p className="qd-sample-reply">
                      示例回复：可以先按产品划分入口，再在每个产品下组织功能介绍、使用指南与常见问题。
                    </p>
                  ) : null}
                  <div className="qd-options">
                    {preview.state === 'approval' ? (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            setState('running');
                            setPreview({ ...preview, state: 'running' });
                          }}
                        >
                          模拟允许
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={closePreview}
                        >
                          返回（不作授权决定）
                        </Button>
                      </>
                    ) : null}
                    {preview.state === 'running' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setState('unread');
                          setPreview({ ...preview, state: 'unread' });
                        }}
                      >
                        模拟本轮结束
                      </Button>
                    ) : null}
                    {preview.state === 'draft' ||
                    preview.state === 'viewed' ||
                    preview.state === 'error' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setState('running');
                          setPreview({ ...preview, state: 'running' });
                        }}
                      >
                        模拟{preview.state === 'error' ? '重试' : '发送'}
                      </Button>
                    ) : null}
                    {preview.state === 'unread' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setState('viewed');
                          setPreview({ ...preview, state: 'viewed' });
                        }}
                      >
                        模拟标为已查看
                      </Button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <p className="qd-preview-empty">
                <MessageCircle aria-hidden size={16} />
                点击卡片上的操作，预览状态如何衔接；所有操作只影响本页。
              </p>
            )}
          </section>

          <details className="qs-history">
            <summary>旧版全状态与 Note 搭配对照</summary>
            <section className="qd-matrix-section" aria-label="全状态对照">
              <header className="qd-section-header">
                <div>
                  <p className="qd-eyebrow">SAME TOPIC, DIFFERENT MOMENTS</p>
                  <h2>放在一起，状态还分得清吗？</h2>
                </div>
                <div
                  className="qd-options"
                  role="group"
                  aria-label="全状态设计方向"
                >
                  {DIRECTIONS.map((direction) => (
                    <Button
                      key={direction.id}
                      variant={
                        matrixDirection === direction.id ? 'solid' : 'outline'
                      }
                      size="sm"
                      aria-pressed={matrixDirection === direction.id}
                      onClick={() => setMatrixDirection(direction.id)}
                    >
                      {direction.title}
                    </Button>
                  ))}
                </div>
              </header>
              <div className="qd-matrix qd-grid-surface">
                {(Object.keys(STATES) as DemoState[]).map((value) => (
                  <div key={value}>
                    <p className="qd-matrix-label">{STATES[value].owner}</p>
                    <QuestionDesignCard
                      direction={matrixDirection}
                      state={value}
                      title={title}
                      agent={agent}
                      overview={overview}
                      onOpen={() => openPreview(value, matrixDirection)}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section aria-label="与内容节点搭配" className="qd-context-section">
              <header className="qd-section-header">
                <div>
                  <p className="qd-eyebrow">IN CONTEXT</p>
                  <h2>回到画布，它是协作入口，不是警报。</h2>
                </div>
                <span className="qd-control-hint">
                  共享节点圆角、边框、留白和中性表面。
                </span>
              </header>
              <div className="qd-context qd-grid-surface">
                <article className="qd-neighbor" style={shellStyle}>
                  <span className="qd-eyebrow">
                    <FileText size={14} aria-hidden /> NOTE · 样例资料
                  </span>
                  <h3>产品网站梳理</h3>
                  <p>让新用户快速找到适合自己的产品，并顺利进入使用指南。</p>
                  <ul>
                    <li>产品介绍与核心能力</li>
                    <li>上手指南与常见问题</li>
                    <li>团队与客户案例</li>
                  </ul>
                </article>
                <span className="qd-context-connector" aria-hidden>
                  ······
                </span>
                <QuestionDesignCard
                  direction={matrixDirection}
                  state={state}
                  title={title}
                  agent={agent}
                  overview={overview}
                  onOpen={() => openPreview(state, matrixDirection)}
                />
                <aside className="qd-design-note">
                  <GitCompareArrows size={20} aria-hidden />
                  <h3>上一版说明</h3>
                  <p>
                    沿 03
                    继续：状态固定在右上角，标题独占下一行。头像使用稳定的气泡轮廓，保留“对话”标识，不把它做成缩小的笔记正文。
                  </p>
                  <p>
                    颜色表示状态，图标表示
                    Agent；不要让整个节点随着每次运行变色。
                  </p>
                </aside>
              </div>
            </section>
          </details>
          <footer className="qd-page-footer">
            <strong>数据边界</strong>
            <dl className="qd-data-contract">
              <div>
                <dt>对话主题与身份</dt>
                <dd>
                  复用 label → 首条 content 的现有回退；Agent
                  名称和图标来自现有绑定 / Profile。
                </dd>
              </div>
              <div>
                <dt>待开始 / 进行中 / 出错</dt>
                <dd>
                  对应 idle / running / error。idle 不证明有草稿；running
                  不证明实时在线，也不提供完成比例。
                </dd>
              </div>
              <div>
                <dt>等你授权</dt>
                <dd>
                  来自未解决的 ACP 权限请求，不泛指“Agent
                  有问题需要你回答”。具体操作须读取请求内容。
                </dd>
              </div>
              <div>
                <dt>本轮结束 / 已查看</dt>
                <dd>
                  对应 done 与 viewed。done
                  可包含取消，不能单凭它声称“新回复”或“任务完成”；viewed
                  不代表读完。
                </dd>
              </div>
              <div>
                <dt>错误原因与回复摘要</dt>
                <dd>
                  有 errorMessage 才能展示具体原因；responseSummary
                  目前没有写入。卡片不编造摘要、耗时或进度。
                </dd>
              </div>
              <div>
                <dt>其他需覆盖的情况</dt>
                <dd>
                  已有修改冲突计数和复制会话中的临时状态，正式接入时需单独处理；本页六态不是完整状态机。
                </dd>
              </div>
            </dl>
            <p>
              本页所有主题、身份、权限操作和展开后的回复都是明确的样例，并未连接实时数据。以上说明的是可用数据来源，不代表已经完成正式接入。
            </p>
            <p>
              本页是独立呈现层实验，没有替换正式
              QuestionNode、写入画布或改变原有缩放行为。
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
