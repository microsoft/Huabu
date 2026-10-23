// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AlertTriangle,
  ArrowUpRight,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import {
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
  resolveAccent,
} from '@huabu/shared';
import { SPACE_SHORTCUT_SIZE } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_POPOVER_CLASS,
} from '@/components/Common/FloatingToolbar';
import { Modal } from '@/components/Common/Modal';
import { Popover } from '@/components/Common/Popover';
import { TextInput } from '@/components/Common/TextInput';
import { Tooltip } from '@/components/Common/Tooltip';
import {
  NODE_BORDER_WIDTH,
  nodeBoundaryForAccent,
} from '@/components/Nodes/design/nodeBoundary';
import { nodeMetricsForSize } from '@/components/Nodes/design/nodeDesign';
import { CONVERSATION_CARD_SPACING } from '@/components/Nodes/design/nodeSpacing';
import { SPACE_CARD_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { noteSurfaceStyle } from '@/components/Nodes/note/noteDesign';
import { NodeActivityTime } from '@/components/Nodes/shared/NodeActivityTime';
import { SpaceAgentActivity } from '@/components/Nodes/spacePreview/SpaceAgentActivity';
import { getNodeIcon } from '@/config/nodeIcons';
import { translateColorOptions } from '@/i18n/colors';

import { SpecimenTypeHandle } from './NodeToolbarPlaygroundPage';
import './NodeToolbarPlaygroundPage.css';
import './SpacePreviewDesignPlaygroundPage.css';

const SpaceIcon = getNodeIcon('spacePreview');
const MIN_WIDTH = SPACE_SHORTCUT_SIZE.minWidth;
const titleTypography = SPACE_CARD_TYPOGRAPHY.title;
const DEMO_UPDATED_AT = Date.now() - 2 * 86_400_000;
const specimens = [
  {
    id: 'primary',
    label: '未选中示例',
    detail: '默认不选中 · 名称与摘要始终可见',
  },
  {
    id: 'reference',
    label: '选中与交互示例',
    detail: '默认选中 · 操作只出现在工具栏',
  },
] as const;
type Selection = (typeof specimens)[number]['id'] | 'all' | null;

function SpaceShortcutSpecimen({
  specimen,
  title,
  unavailable,
  selected,
  onSelect,
  onDeselect,
  onOpen,
}: {
  specimen: (typeof specimens)[number];
  title: string;
  unavailable: boolean;
  selected: boolean;
  onSelect: () => void;
  onDeselect: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [color, setColor] = useState('none');
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [manualWidth, setManualWidth] = useState<number>(
    SPACE_SHORTCUT_SIZE.defaultWidth,
  );
  const [widthOpen, setWidthOpen] = useState(false);
  const [measured, setMeasured] = useState<{ width: number; height: number }>({
    width: MIN_WIDTH,
    height: 0,
  });
  const nodeRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef<HTMLButtonElement>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    manualWidth: number;
    position: { x: number; y: number };
    max: number;
  } | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      setMeasured((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const colors = translateColorOptions(
    ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
    t,
  );
  const accent = color === 'none' ? null : resolveAccent(color);
  const boundary = nodeBoundaryForAccent(accent);
  const height =
    2 * (CONVERSATION_CARD_SPACING.padding + boundary.borderWidth) +
    titleTypography.size * titleTypography.lineHeight +
    (unavailable
      ? 0
      : CONVERSATION_CARD_SPACING.rowGap +
        CONVERSATION_CARD_SPACING.footerHeight);
  const openSpace = () => {
    if (!unavailable) onOpen();
  };
  const cancelResize = () => {
    const start = resize.current;
    if (!start) return;
    resize.current = null;
    setManualWidth(start.manualWidth);
    setPosition(start.position);
  };
  const availableWidth = () => {
    const stage = nodeRef.current?.parentElement?.parentElement;
    if (!stage) return Infinity;
    const style = getComputedStyle(stage);
    return (
      stage.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    );
  };

  return (
    <section className="sp-design-specimen" aria-label={specimen.label}>
      <div className="sp-design-caption">
        <h2>{specimen.label}</h2>
        <span className="sp-design-subtitle">{specimen.detail}</span>
      </div>
      <div className="sp-design-stage">
        <div
          className="sp-design-movable"
          data-authored-width={manualWidth}
          style={{
            width: manualWidth,
            minWidth: `min(${MIN_WIDTH}px, 100%)`,
            maxWidth: '100%',
            transform: `translate(${position.x}px, ${position.y}px)`,
          }}
        >
          <div
            ref={nodeRef}
            className="sp-design-node"
            data-specimen={specimen.id}
            data-selected={selected}
            style={{
              borderRadius: nodeMetricsForSize(
                measured.width,
                measured.height || height,
              ).radius,
            }}
          >
            <Button
              variant="ghost"
              className="sp-design-shortcut"
              style={{
                ...noteSurfaceStyle(accent),
                ...boundary,
                padding: CONVERSATION_CARD_SPACING.padding,
                paddingInline:
                  CONVERSATION_CARD_SPACING.padding - boundary.borderWidth,
                fontSize: titleTypography.size,
                fontWeight: titleTypography.weight,
                lineHeight: titleTypography.lineHeight,
              }}
              aria-label={`${specimen.label} · 空间快捷入口 · ${title}，单击选择，双击或 Enter 进入空间`}
              aria-pressed={selected}
              aria-describedby={
                unavailable
                  ? `sp-unavailable-${specimen.id}`
                  : 'sp-design-gestures'
              }
              onClick={onSelect}
              onDoubleClick={openSpace}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSelect();
                  openSpace();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setWidthOpen(false);
                  onDeselect();
                }
              }}
            >
              <span className="sp-design-copy">
                <span className="flex items-start gap-2">
                  <span
                    className="text-fg-muted inline-flex h-[1lh] shrink-0 items-center justify-center"
                    style={{ width: CONVERSATION_CARD_SPACING.iconSlotWidth }}
                    data-space-type-icon
                    aria-hidden
                  >
                    <SpaceIcon
                      size={CONVERSATION_CARD_SPACING.spaceIconSize}
                      style={{
                        width: CONVERSATION_CARD_SPACING.spaceIconSize,
                        height: CONVERSATION_CARD_SPACING.spaceIconSize,
                      }}
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 items-start gap-1">
                    <span className="sp-design-title" title={title}>
                      {title}
                    </span>
                    <Tooltip
                      content={t('spacePreview.shortcutLabel')}
                      wrapperClassName="inline-flex h-[1lh] shrink-0 items-center"
                    >
                      <ArrowUpRight
                        size="1em"
                        style={{ width: '1em', height: '1em' }}
                        aria-label={t('spacePreview.shortcutLabel')}
                      />
                    </Tooltip>
                  </span>
                </span>
                {!unavailable ? (
                  <span
                    className="flex items-center gap-2"
                    style={{ height: CONVERSATION_CARD_SPACING.footerHeight }}
                  >
                    <SpaceAgentActivity
                      activity={[
                        {
                          nodeId: 'node-demo-1',
                          threadId: 'demo-1',
                          title: 'Research',
                          status: 'running',
                          agentBinding: { kind: 'internal' },
                        },
                        {
                          nodeId: 'node-demo-2',
                          threadId: 'demo-2',
                          title: 'Review',
                          status: 'approval',
                          agentBinding: { kind: 'internal' },
                        },
                      ]}
                    />
                    <NodeActivityTime updatedAt={DEMO_UPDATED_AT} />
                  </span>
                ) : null}
              </span>
              {unavailable ? (
                <AlertTriangle className="text-warning" aria-hidden />
              ) : null}
            </Button>
            {selected
              ? (['left', 'right'] as const).map((side) => (
                  <Button
                    key={side}
                    variant="ghost"
                    className="sp-design-width-grip"
                    data-side={side}
                    aria-label={
                      side === 'left' ? '从左侧调整宽度' : '从右侧调整宽度'
                    }
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !event.isPrimary) return;
                      event.preventDefault();
                      event.currentTarget.focus({ preventScroll: true });
                      const node = nodeRef.current;
                      if (!node) return;
                      resize.current = {
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        width: node.getBoundingClientRect().width,
                        manualWidth,
                        position,
                        max: availableWidth(),
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const start = resize.current;
                      if (!start || start.pointerId !== event.pointerId) return;
                      const delta = event.clientX - start.startX;
                      if (Math.abs(delta) < 3) return;
                      const next = Math.round(
                        Math.min(
                          start.max,
                          Math.max(
                            Math.min(MIN_WIDTH, start.max),
                            start.width + (side === 'left' ? -delta : delta),
                          ),
                        ),
                      );
                      setManualWidth(Math.max(MIN_WIDTH, next));
                      if (side === 'left')
                        setPosition({
                          ...start.position,
                          x: start.position.x + start.width - next,
                        });
                    }}
                    onPointerUp={(event) => {
                      if (resize.current?.pointerId !== event.pointerId) return;
                      resize.current = null;
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                    }}
                    onPointerCancel={cancelResize}
                    onLostPointerCapture={cancelResize}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelResize();
                      } else if (
                        event.key === 'ArrowLeft' ||
                        event.key === 'ArrowRight'
                      ) {
                        event.preventDefault();
                        const delta =
                          (event.key === 'ArrowRight' ? 16 : -16) *
                          (side === 'left' ? -1 : 1);
                        const max = availableWidth();
                        const currentWidth =
                          nodeRef.current?.getBoundingClientRect().width ??
                          measured.width;
                        const next = Math.round(
                          Math.min(
                            max,
                            Math.max(
                              Math.min(MIN_WIDTH, max),
                              currentWidth + delta,
                            ),
                          ),
                        );
                        setManualWidth(Math.max(MIN_WIDTH, next));
                        if (side === 'left')
                          setPosition((current) => ({
                            ...current,
                            x: current.x + currentWidth - next,
                          }));
                      }
                    }}
                  >
                    <span aria-hidden />
                  </Button>
                ))
              : null}
          </div>
          {unavailable ? (
            <p
              id={`sp-unavailable-${specimen.id}`}
              className="sp-design-unavailable"
              role="status"
            >
              空间已删除或不可访问，无法进入
            </p>
          ) : null}
          {selected ? (
            <div
              className="sp-design-toolbar-slot"
              role="group"
              aria-label={`${specimen.label}工具栏`}
            >
              <FloatingToolbar className="nt-toolbar">
                <SpecimenTypeHandle
                  type="spacePreview"
                  label="Space Shortcut"
                  position={position}
                  onMove={setPosition}
                />
                <FloatingToolbar.Divider />
                <FloatingToolbar.ColorPicker
                  floating
                  colors={colors}
                  value={color}
                  onSelect={setColor}
                  title="节点颜色"
                  triggerClassName="nt-tool nt-color"
                />
                <Button
                  ref={widthRef}
                  variant="ghost"
                  iconOnly
                  title="宽度设置"
                  aria-expanded={widthOpen}
                  onClick={() => setWidthOpen(!widthOpen)}
                >
                  <Settings2 />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  title="进入空间（演示）"
                  disabled={unavailable}
                  onClick={openSpace}
                >
                  <ArrowUpRight />
                </Button>
              </FloatingToolbar>
              {widthOpen ? (
                <Popover
                  reference={widthRef.current}
                  placement="bottom"
                  offset={{ x: 0, y: 8 }}
                  onDismiss={() => setWidthOpen(false)}
                  className={FLOATING_TOOLBAR_POPOVER_CLASS}
                >
                  <FloatingToolbar.SizePicker
                    width={measured.width}
                    height={null}
                    showHeight={false}
                    minSize={MIN_WIDTH}
                    onApply={({ width }) => {
                      if (width !== undefined) setManualWidth(width);
                    }}
                  />
                </Popover>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="sp-design-size-readout">
          {`宽度 ${manualWidth}`}
          {' · '}当前 {Math.round(measured.width)} ×{' '}
          {Math.round(measured.height)}
          {' · '}高度随文字变化
        </p>
      </div>
    </section>
  );
}

export default function SpacePreviewDesignPlaygroundPage() {
  const [unavailable, setUnavailable] = useState(false);
  const [title, setTitle] = useState('Design notebook');
  const [selection, setSelection] = useState<Selection>('reference');
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const displayTitle = title.trim() || '未命名空间';
  return (
    <main className="sp-design-page">
      <header className="sp-design-page-header">
        <div>
          <span className="nt-eyebrow">
            HUABU / PLAYGROUND / SPACE SHORTCUT
          </span>
          <h1>一个空间入口，不再嵌入一张画布。</h1>
          <p>
            同一个设计的两种状态示例，并非两个候选方案。沿用正式节点的边界、圆角、文字和颜色规则。
          </p>
        </div>
        <Link
          to="/playground/design#zoomed-overview"
          className="sp-design-back"
        >
          对照其他节点 <ArrowUpRight size={14} />
        </Link>
      </header>
      <section className="sp-design-controls" aria-label="对比设置">
        <div
          role="group"
          aria-label="目标空间状态"
          className="sp-design-state-picker"
        >
          {[
            { label: '正常', value: false },
            { label: '空间失效', value: true },
          ].map((entry) => (
            <Button
              key={entry.label}
              variant={unavailable === entry.value ? 'solid' : 'ghost'}
              size="sm"
              aria-pressed={unavailable === entry.value}
              onClick={() => setUnavailable(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <label className="sp-design-title-input" htmlFor="sp-design-title">
          目标名称
          <TextInput
            id="sp-design-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="sp-design-checkbox">
          <input
            type="checkbox"
            checked={selection === 'all'}
            onChange={(event) =>
              setSelection(event.target.checked ? 'all' : null)
            }
          />
          同时展示工具栏
        </label>
        <Button variant="ghost" size="sm" onClick={() => setTitle('研究')}>
          测试短标题
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setTitle(
              'Design notebook / 关于日常观察与未来产品的一些很长很长的想法，以及下一阶段的研究方向',
            )
          }
        >
          测试长标题
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setUnavailable(false);
            setTitle('Design notebook');
            setSelection('reference');
            setRevision((value) => value + 1);
          }}
        >
          <RotateCcw />
          重置样例
        </Button>
      </section>
      <div id="sp-design-gestures" className="sp-design-gestures">
        <span>
          单击 / Space <strong>选择</strong>
        </span>
        <span>
          双击 / Enter <strong>进入空间</strong>
        </span>
        <span>
          工具栏 <strong>拖动 · 颜色 · 宽度 · 进入</strong>
        </span>
        <span>
          左右手柄 <strong>调宽 · 方向键微调 · Esc 撤销拖拽</strong>
        </span>
        <span>
          Esc <strong>取消选择</strong>
        </span>
      </div>
      <div className="sp-design-gallery" key={revision}>
        {specimens.map((specimen) => (
          <SpaceShortcutSpecimen
            key={specimen.id}
            specimen={specimen}
            title={displayTitle}
            unavailable={unavailable}
            selected={selection === 'all' || selection === specimen.id}
            onSelect={() => setSelection(specimen.id)}
            onDeselect={() => setSelection(null)}
            onOpen={() => setOpen(true)}
          />
        ))}
      </div>
      <aside className="sp-design-notes">
        <div>
          <span>01 / 使用同一套节点规范</span>
          <p>
            {NODE_BORDER_WIDTH}px 边界、{CONVERSATION_CARD_SPACING.padding}px
            内边距、共享圆角、24px / 500 卡片标题，以及 Note / Web / PDF
            的表面与强调色。不增加阴影或新的边框颜色。
          </p>
        </div>
        <div>
          <span>02 / 入口，不是缩略画布</span>
          <p>
            仅保留目标名称、Agent
            活动和相对更新时间。没有图标、封面、快照加载、内部缩放或大面积空白，也不显示
            URL 和常驻跳转箭头。
          </p>
        </div>
        <div>
          <span>03 / 引用，不代表从属</span>
          <p>
            两个样例共享目标名称，但各自保留位置和颜色。入口不复制空间内容，也不意味着父子关系。
          </p>
        </div>
      </aside>
      <section className="sp-design-rules" aria-label="Space Shortcut 设计记录">
        <h2>Space Shortcut / 本轮设计记录</h2>
        <dl>
          <dt>定位</dt>
          <dd>
            指向并进入已有 Space
            的快捷入口，不展示其内部内容，不复制节点，也不由此建立父子关系。
          </dd>
          <dt>默认宽度</dt>
          <dd>
            新建入口统一为 {SPACE_SHORTCUT_SIZE.defaultWidth}
            画布单位。名称和摘要变化不会改变宽度。
          </dd>
          <dt>文字与高度</dt>
          <dd>
            短标题一行，长标题最多两行，超出省略；悬停标题查看全名。字号固定为
            24，不随宽度缩放；摘要固定一行，高度只随标题行数变化，不提供高度输入或上下拉伸。
          </dd>
          <dt>空间摘要</dt>
          <dd>
            标题下方间隔 4px，以 18px / 400 展示 Agent
            活动和相对更新时间，始终共用一行，放不下的对话收进「+N」。悬停时间可查看精确时间。样例固定为
            1 个运行中、1
            个待审批、两天前更新；目标失效时隐藏摘要，不请求真实空间数据。
          </dd>
          <dt>手动宽度</dt>
          <dd>
            工具栏「宽度设置」使用共享 SizePicker，输入不小于 {MIN_WIDTH}
            的有限整数后应用，宽度不设上限。也可拖动左右手柄；键盘左右键每次调整
            16。
          </dd>
          <dt>改名与恢复</dt>
          <dd>
            改名保留指定宽度，只重新换行。两个引用共享名称，各自保留宽度、颜色和位置。
          </dd>
          <dt>小屏与单位</dt>
          <dd>
            此页按 1:1
            展示画布单位。可见宽度不超过演示区域；较大的手动宽度仍保留，扩大窗口后恢复显示。下方读数显示实际尺寸，不代表缩放了字号。
          </dd>
          <dt>交互与状态</dt>
          <dd>
            单击 / Space 选择，双击 / Enter
            或工具栏进入。失效目标显示原因并禁用所有进入路径，仍可选中和调宽。没有封面、快照重试、URL
            或常驻打开箭头。
          </dd>
          <dt>正式接入边界</dt>
          <dd>
            此页只演示样式和交互，刷新后重置；不写入真实
            Space。正式节点已接入目标名称、导航、宽度持久化、画布缩放和连线。删除普通快捷入口不会删除目标；World
            自动管理入口的保护规则保持不变。此页的键盘调宽和小屏约束仅用于演示。
          </dd>
        </dl>
        <h2 className="mt-6">建议按这个顺序体验</h2>
        <p>
          ① 测试短 / 长标题，确认宽度不变、高度随一 / 两行变化 → ②
          在「选中与交互示例」的宽度设置中应用 320，再改名，确认宽度不变 → ③
          拖左右手柄或用方向键，确认字号不变 → ④ 切换空间失效，检查进入被禁用。
        </p>
      </section>
      <p className="sp-design-state-hint">
        仅 Playground 演示 · 使用正式节点设计函数 · 不读取或修改真实 Space ·
        正式节点已采用快捷入口设计
      </p>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={displayTitle}
        description="这是进入目标空间的本地演示，不会跳转或修改真实空间。"
        className="max-w-3xl"
        footer={
          <Button variant="outline" onClick={() => setOpen(false)}>
            返回对比
          </Button>
        }
      >
        <div className="sp-design-destination">
          <SpaceIcon size={32} />
          <p>这里将进入「{displayTitle}」的完整画布。</p>
          <span>阅读、缩放和编辑都在目标空间内进行，而不是在入口节点中。</span>
        </div>
      </Modal>
    </main>
  );
}
