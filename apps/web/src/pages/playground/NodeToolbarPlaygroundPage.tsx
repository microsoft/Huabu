// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import {
  Columns3,
  ArrowUpRight,
  Bold,
  Check,
  ChevronDown,
  Download,
  Ellipsis,
  Grid2X2,
  ImageOff,
  Italic,
  Link,
  Maximize2,
  MessageSquare,
  Move,
  SquareArrowRightEnter,
  Pause,
  Play,
  RotateCcw,
  Rows3,
  Settings2,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Ungroup,
} from 'lucide-react';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';

import { ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT } from '@huabu/shared';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSubmenu,
} from '@/components/Common/DropdownMenu';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_POPOVER_CLASS,
} from '@/components/Common/FloatingToolbar';
import { Modal } from '@/components/Common/Modal';
import { Select } from '@/components/Common/Select';
import { SketchControls } from '@/components/Nodes/sketch/SketchControls';
import { SKETCH_COLOR_OPTIONS } from '@/components/Nodes/sketch/sketchPath';
import { MoveSelectionPanel } from '@/components/Panels/Canvas/MoveSelectionPanel';
import { NODE_ICON, NODE_TYPE_LABEL } from '@/config/nodeIcons';
import { translateColorOptions } from '@/i18n/colors';

import coverImage from './assets/overview-cover.png';
import './NodeToolbarPlaygroundPage.css';

import type { CanvasNodeType } from '@huabu/shared';

export const TOOLBAR_SPECIMENS = {
  note: { title: 'Ideas worth keeping', category: '内容' },
  text: { title: 'Make room for a new perspective.', category: '内容' },
  image: { title: 'A little room for big ideas', category: '媒体' },
  pdf: { title: 'The shape of everyday things', category: '资料' },
  web: { title: 'A field guide to observation', category: '资料' },
  office: { title: 'Research findings', category: '资料' },
  video: { title: 'In motion', category: '媒体' },
  audio: { title: 'A conversation in the studio', category: '媒体' },
  sketch: { title: 'An early thought', category: '内容' },
  frame: { title: 'Collect, connect, create', category: '组织' },
  question: { title: 'What connects these ideas?', category: '智能体' },
  spacePreview: { title: 'Design notebook', category: '组织' },
} satisfies Record<CanvasNodeType, { title: string; category: string }>;

function ToolButton({
  label,
  children,
  onClick,
  active,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <FloatingToolbar.ToggleButton
      title={label}
      active={active ?? false}
      className={`nt-tool ${className}`}
      onClick={() => onClick?.()}
    >
      {children}
    </FloatingToolbar.ToggleButton>
  );
}

export function SpecimenTypeHandle({
  type,
  label = NODE_TYPE_LABEL[type],
  position,
  onMove,
  onActivate,
  active,
}: {
  type: CanvasNodeType;
  label?: string;
  position: { x: number; y: number };
  onMove: (position: { x: number; y: number }) => void;
  onActivate?: () => void;
  active?: boolean;
}) {
  const suppressClick = useRef(false);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    origin: typeof position;
  } | null>(null);
  const Icon = NODE_ICON[type];
  return (
    <Button
      variant="ghost"
      iconOnly
      title={`${label} · 拖动节点`}
      className="nt-tool nt-type-handle"
      aria-pressed={active}
      onClick={() => {
        if (!suppressClick.current) onActivate?.();
        suppressClick.current = false;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        suppressClick.current = false;
        gesture.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          origin: position,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = gesture.current;
        if (!start || start.pointerId !== event.pointerId) return;
        if (
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < 3 &&
          !suppressClick.current
        )
          return;
        suppressClick.current = true;
        onMove({
          x: start.origin.x + event.clientX - start.x,
          y: start.origin.y + event.clientY - start.y,
        });
      }}
      onPointerUp={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        gesture.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (gesture.current) suppressClick.current = true;
        if (gesture.current) onMove(gesture.current.origin);
        gesture.current = null;
      }}
      onPointerCancel={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        suppressClick.current = true;
        onMove(gesture.current.origin);
        gesture.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !gesture.current) return;
        const start = gesture.current;
        suppressClick.current = true;
        onMove(start.origin);
        gesture.current = null;
        event.currentTarget.releasePointerCapture(start.pointerId);
      }}
    >
      <Icon />
    </Button>
  );
}

function Specimen({ type: initialType }: { type: CanvasNodeType }) {
  const { t } = useTranslation();
  const colors = translateColorOptions(
    ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
    t,
  );
  const [type, setType] = useState(initialType);
  const initial = TOOLBAR_SPECIMENS[initialType];
  const title = initial.title;
  const [color, setColor] = useState(colors[0].token);
  const [strokeColor, setStrokeColor] = useState('black');
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [underline, setUnderline] = useState(false);
  const [strike, setStrike] = useState(false);
  const [fontFamily, setFontFamily] = useState('inherit');
  const [fontSize, setFontSize] = useState(24);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [layout, setLayout] = useState('grid');
  const [autoHeight, setAutoHeight] = useState(true);
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [questionState, setQuestionState] = useState('draft');
  const [questionScale, setQuestionScale] = useState(100);
  const [hasCover, setHasCover] = useState(true);
  const [remoteWeb, setRemoteWeb] = useState(true);
  const [missing, setMissing] = useState(false);
  const [gridRows, setGridRows] = useState(2);
  const [gridColumns, setGridColumns] = useState(2);
  const [unframed, setUnframed] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [dialog, setDialog] = useState<'preview' | 'move' | null>(null);
  const [sizeOpen, setSizeOpen] = useState(false);
  const sizePopover = useFloating({
    open: sizeOpen,
    onOpenChange: setSizeOpen,
    placement: 'bottom',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const sizeDismiss = useDismiss(sizePopover.context);
  const sizeRole = useRole(sizePopover.context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    sizeDismiss,
    sizeRole,
  ]);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [feedback, setFeedback] = useState('');
  const [width, setWidth] = useState(320);
  const [height, setHeight] = useState(180);
  const [moreOpen, setMoreOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const Icon = NODE_ICON[type];
  const accent =
    type === 'sketch'
      ? SKETCH_COLOR_OPTIONS.find((entry) => entry.token === strokeColor)?.value
      : color === 'none'
        ? 'var(--fg-default)'
        : colors.find((entry) => entry.token === color)?.value;

  const content = (
    <NodeSample
      type={type}
      title={title}
      playing={questionState === 'running'}
      layout={layout}
      strokeWidth={strokeWidth}
    />
  );

  return (
    <section
      className="nt-specimen"
      id={`toolbar-${initialType}`}
      data-node-type={initialType}
    >
      <header className="nt-specimen-heading">
        <span>
          <Icon size={15} />
          {NODE_TYPE_LABEL[type]}
        </span>
        <div className="flex items-center gap-2">
          {type === 'question' && (
            <Select
              ariaLabel="Agent 样例状态"
              size="sm"
              variant="ghost"
              value={questionState}
              onChange={setQuestionState}
              options={[
                { value: 'draft', label: '草稿' },
                { value: 'ready', label: '已有对话' },
                { value: 'running', label: '运行中' },
                { value: 'fork', label: '复制会话中' },
              ]}
            />
          )}
          {type === 'pdf' && (
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={hasCover}
                onChange={(event) => setHasCover(event.target.checked)}
              />
              封面
            </label>
          )}
          {type === 'web' && (
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={remoteWeb}
                onChange={(event) => setRemoteWeb(event.target.checked)}
              />
              远程网址
            </label>
          )}
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={missing}
              onChange={(event) => setMissing(event.target.checked)}
            />
            内容缺失
          </label>
        </div>
      </header>
      {deleted ? (
        <div className="nt-deleted">
          <span>已移除样例</span>
          <Button variant="outline" size="sm" onClick={() => setDeleted(false)}>
            <RotateCcw />
            恢复
          </Button>
        </div>
      ) : (
        <div className="nt-stage">
          <div
            className="nt-movable"
            style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
          >
            <div
              role="group"
              aria-label={`${NODE_TYPE_LABEL[type]} 工具栏`}
              className="nt-toolbar-anchor"
            >
              <FloatingToolbar className="nt-toolbar">
                <SpecimenTypeHandle
                  type={type}
                  position={position}
                  onMove={setPosition}
                />
                <span className="nt-divider" />
                {type !== 'question' && type !== 'sketch' && (
                  <FloatingToolbar.ColorPicker
                    floating
                    colors={colors}
                    value={color}
                    onSelect={setColor}
                    title="节点颜色"
                    triggerClassName="nt-tool nt-color"
                  />
                )}
                {type === 'text' && (
                  <div className="nt-font-size" role="group" aria-label="字号">
                    <FloatingToolbar.NumberInput
                      label=""
                      ariaLabel="字号"
                      title="字号"
                      name="font-size"
                      min={8}
                      max={160}
                      value={fontSize}
                      onApply={setFontSize}
                      inputClassName="w-7"
                      unstyled
                    />
                    <DropdownMenu
                      floating
                      align="bottom-right"
                      className="nt-font-size-menu"
                      open={fontSizeOpen}
                      onOpenChange={setFontSizeOpen}
                      trigger={
                        <Button
                          variant="ghost"
                          iconOnly
                          title="常用字号"
                          className="nt-font-size-trigger"
                          aria-haspopup="menu"
                        >
                          <ChevronDown />
                        </Button>
                      }
                    >
                      {[
                        8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72,
                        96, 120, 160,
                      ].map((size) => (
                        <DropdownMenuItem
                          key={size}
                          aria-current={fontSize === size ? 'true' : undefined}
                          trailing={
                            fontSize === size ? <Check size={14} /> : undefined
                          }
                          onClick={() => {
                            setFontSize(size);
                            setFontSizeOpen(false);
                          }}
                        >
                          {size}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenu>
                  </div>
                )}
                {type === 'text' && !missing && (
                  <>
                    <ToolButton
                      label="加粗"
                      className="nt-text-format"
                      active={bold}
                      onClick={() => setBold(!bold)}
                    >
                      <Bold />
                    </ToolButton>
                    <ToolButton
                      label="斜体"
                      className="nt-text-format"
                      active={italic}
                      onClick={() => setItalic(!italic)}
                    >
                      <Italic />
                    </ToolButton>
                  </>
                )}
                {type === 'text' && <span className="nt-divider" />}
                {type === 'sketch' && !missing && (
                  <SketchControls
                    floating
                    color={strokeColor}
                    size={strokeWidth}
                    colorTriggerClassName="nt-tool nt-color"
                    onColorChange={setStrokeColor}
                    onSizeChange={setStrokeWidth}
                  />
                )}
                <Button
                  ref={sizePopover.refs.setReference}
                  {...getReferenceProps()}
                  variant="ghost"
                  iconOnly
                  title="尺寸"
                  className="nt-tool"
                  aria-expanded={sizeOpen}
                  onClick={() => setSizeOpen(!sizeOpen)}
                >
                  <Settings2 />
                </Button>
                {type === 'frame' && !missing && (
                  <DropdownMenu
                    floating
                    placement="bottom"
                    className="nt-layout-panel"
                    trigger={
                      <Button
                        variant="ghost"
                        iconOnly
                        title="布局"
                        className="nt-tool"
                      >
                        <Grid2X2 />
                      </Button>
                    }
                  >
                    <div
                      className="nt-layout-modes"
                      role="group"
                      aria-label="布局"
                    >
                      {[
                        {
                          value: 'free',
                          label: t('node.frameLayoutFree'),
                          icon: <Move size={16} />,
                        },
                        {
                          value: 'row',
                          label: t('node.frameLayoutRow'),
                          icon: <Rows3 size={16} />,
                        },
                        {
                          value: 'column',
                          label: t('node.frameLayoutColumn'),
                          icon: <Columns3 size={16} />,
                        },
                        {
                          value: 'grid',
                          label: t('node.frameLayoutGrid'),
                          icon: <Grid2X2 size={16} />,
                        },
                      ].map((option) => (
                        <Button
                          key={option.value}
                          variant="ghost"
                          iconOnly
                          title={option.label}
                          tooltipWrapperClassName="nt-layout-option"
                          aria-pressed={layout === option.value}
                          onClick={() => setLayout(option.value)}
                        >
                          {option.icon}
                        </Button>
                      ))}
                    </div>
                    {layout !== 'free' && (
                      <>
                        <div
                          role="group"
                          aria-label="行列数量"
                          className="nt-layout-counts"
                        >
                          {(layout === 'grid' || layout === 'row') && (
                            <FloatingToolbar.NumberInput
                              label="行"
                              ariaLabel="行数"
                              name="rows"
                              value={gridRows}
                              min={1}
                              max={layout === 'grid' ? 12 : 3}
                              onApply={setGridRows}
                            />
                          )}
                          {layout !== 'row' && (
                            <FloatingToolbar.NumberInput
                              label="列"
                              ariaLabel="列数"
                              name="columns"
                              value={gridColumns}
                              min={1}
                              max={3}
                              onApply={setGridColumns}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </DropdownMenu>
                )}
                {type === 'question' &&
                  !missing &&
                  questionState !== 'fork' && (
                    <ToolButton
                      label={
                        questionState === 'draft'
                          ? '提问'
                          : questionState === 'running'
                            ? '查看实时对话'
                            : '查看对话'
                      }
                      onClick={() => setDialog('preview')}
                    >
                      <Maximize2 />
                    </ToolButton>
                  )}
                {!missing &&
                  ['note', 'image', 'pdf', 'office', 'web', 'video'].includes(
                    type,
                  ) && (
                    <ToolButton
                      label="展开预览"
                      onClick={() => setDialog('preview')}
                    >
                      <Maximize2 />
                    </ToolButton>
                  )}
                <span className="nt-divider" />
                <DropdownMenu
                  floating
                  align="bottom-left"
                  className="nt-menu nt-overflow-menu"
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                  trigger={
                    <Button
                      ref={moreButtonRef}
                      variant="ghost"
                      iconOnly
                      title="更多"
                      className="nt-tool"
                    >
                      <Ellipsis />
                    </Button>
                  }
                >
                  {(type === 'text' || type === 'note') && (
                    <DropdownMenuItem
                      icon={
                        type === 'text' ? (
                          <NODE_ICON.note size={15} />
                        ) : (
                          <NODE_ICON.text size={15} />
                        )
                      }
                      onClick={() => {
                        setType(type === 'text' ? 'note' : 'text');
                        setMoreOpen(false);
                        setSizeOpen(false);
                      }}
                    >
                      {type === 'text' ? '转换为 Note' : '转换为 Text'}
                    </DropdownMenuItem>
                  )}
                  {type === 'text' && !missing && (
                    <>
                      <DropdownMenuItem
                        icon={<Underline size={15} />}
                        trailing={underline ? <Check size={14} /> : undefined}
                        onClick={() => setUnderline(!underline)}
                      >
                        下划线
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        icon={<Strikethrough size={15} />}
                        trailing={strike ? <Check size={14} /> : undefined}
                        onClick={() => setStrike(!strike)}
                      >
                        删除线
                      </DropdownMenuItem>
                      <DropdownMenuSubmenu
                        className="nt-overflow-menu nt-font-menu"
                        label={
                          <span className="flex items-center gap-2">
                            <Type size={15} aria-hidden="true" />
                            字体
                          </span>
                        }
                      >
                        {[
                          { value: 'inherit', label: '默认' },
                          { value: 'serif', label: '衬线' },
                          { value: 'monospace', label: '等宽' },
                          { value: 'cursive', label: '手写' },
                        ].map((font) => (
                          <DropdownMenuItem
                            key={font.value}
                            aria-current={
                              fontFamily === font.value ? 'true' : undefined
                            }
                            trailing={
                              fontFamily === font.value ? (
                                <Check size={14} />
                              ) : undefined
                            }
                            onClick={() => {
                              setFontFamily(font.value);
                              setMoreOpen(false);
                            }}
                          >
                            {font.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubmenu>
                    </>
                  )}
                  {!missing && (type === 'pdf' || type === 'office') && (
                    <DropdownMenuItem
                      icon={<Download size={15} />}
                      onClick={() => {
                        setFeedback('下载入口预览：未绑定实际文件');
                        setMoreOpen(false);
                      }}
                    >
                      下载原文件
                    </DropdownMenuItem>
                  )}
                  {!missing && type === 'pdf' && hasCover && (
                    <DropdownMenuItem
                      icon={<ImageOff size={15} />}
                      onClick={() => {
                        setHasCover(false);
                        setMoreOpen(false);
                      }}
                    >
                      删除封面
                    </DropdownMenuItem>
                  )}
                  {!missing && type === 'web' && remoteWeb && (
                    <DropdownMenuItem
                      icon={<ArrowUpRight size={15} />}
                      onClick={() => {
                        setFeedback('原网址入口预览：journal.example.com');
                        setMoreOpen(false);
                      }}
                    >
                      打开原网址
                    </DropdownMenuItem>
                  )}
                  {!missing && type === 'frame' && (
                    <DropdownMenuItem
                      icon={<Ungroup size={15} />}
                      onClick={() => {
                        setUnframed(true);
                        setMoreOpen(false);
                      }}
                    >
                      解除 Frame
                    </DropdownMenuItem>
                  )}
                  {type !== 'spacePreview' && (
                    <DropdownMenuItem
                      icon={<SquareArrowRightEnter size={15} />}
                      onClick={() => {
                        setMoreOpen(false);
                        setDialog('move');
                      }}
                    >
                      移至其他 Space
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    icon={<Link size={15} />}
                    onClick={() => {
                      setMoreOpen(false);
                      void navigator.clipboard
                        .writeText(
                          `${window.location.origin}${window.location.pathname}#toolbar-${initialType}`,
                        )
                        .then(() => setFeedback('已复制样例链接'))
                        .catch(() => setFeedback('无法访问剪贴板'));
                    }}
                  >
                    复制链接
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-danger"
                    icon={<Trash2 size={15} />}
                    onClick={() => {
                      setDeleted(true);
                      setMoreOpen(false);
                    }}
                  >
                    删除
                  </DropdownMenuItem>
                </DropdownMenu>
              </FloatingToolbar>
            </div>
            <div
              className={`nt-node nt-node-${type}`}
              data-layout={layout}
              data-auto-height={autoHeight}
              data-cover={hasCover}
              data-unframed={unframed}
              style={
                {
                  '--nt-accent': accent,
                  '--nt-font-size': `${fontSize}px`,
                  fontWeight: bold ? 700 : undefined,
                  fontStyle: italic ? 'italic' : undefined,
                  textDecoration:
                    [underline ? 'underline' : '', strike ? 'line-through' : '']
                      .filter(Boolean)
                      .join(' ') || undefined,
                  fontFamily,
                  '--nt-grid-columns':
                    layout === 'row' ? Math.ceil(3 / gridRows) : gridColumns,
                  '--nt-grid-rows': gridRows,
                  '--nt-question-scale': questionScale / 100,
                  width: `${width}px`,
                  minHeight:
                    type === 'note' && !autoHeight ? undefined : `${height}px`,
                  height:
                    type === 'note' && !autoHeight ? `${height}px` : undefined,
                } as CSSProperties
              }
            >
              {missing ? <p>内容不可用</p> : content}
            </div>
          </div>
          <span role="status" className="nt-feedback">
            {feedback}
          </span>
        </div>
      )}
      {sizeOpen && !deleted && (
        <FloatingPortal>
          <FloatingFocusManager context={sizePopover.context} modal={false}>
            <div
              ref={sizePopover.refs.setFloating}
              {...getFloatingProps()}
              aria-label="尺寸"
              className={`${FLOATING_TOOLBAR_POPOVER_CLASS} flex items-center gap-2`}
              style={{
                ...sizePopover.floatingStyles,
                zIndex: 9999,
                visibility: sizePopover.isPositioned ? 'visible' : 'hidden',
              }}
            >
              <FloatingToolbar.SizePicker
                width={width}
                height={height}
                showHeight={type !== 'text' && type !== 'question'}
                heightAuto={
                  type === 'note'
                    ? {
                        active: autoHeight,
                        onToggle: () => setAutoHeight(!autoHeight),
                      }
                    : undefined
                }
                autoSize={
                  type === 'frame'
                    ? {
                        dimensions: 'both',
                        togglePosition: 'end',
                        appearance: 'separate',
                        active: autoHeight,
                        onToggle: () => setAutoHeight(!autoHeight),
                      }
                    : undefined
                }
                onApply={(size) => {
                  if (size.width !== undefined) setWidth(size.width);
                  if (size.height !== undefined) setHeight(size.height);
                  if (
                    type === 'frame' ||
                    (type === 'note' && size.height !== undefined)
                  )
                    setAutoHeight(false);
                }}
              />
              {type === 'question' && (
                <FloatingToolbar.NumberInput
                  label=""
                  ariaLabel="卡片缩放"
                  title="卡片缩放"
                  name="question-scale"
                  min={10}
                  max={1000}
                  value={questionScale}
                  onApply={setQuestionScale}
                  inputClassName="w-9"
                  endAdornment={
                    <span className="text-fg-subtle text-xs">%</span>
                  }
                />
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
      {dialog === 'move' && (
        <MoveSelectionPanel
          reference={moreButtonRef.current}
          count={1}
          includesFrames={type === 'frame'}
          options={['Design notebook', 'Research archive'].map((value) => ({
            value,
            label: value,
          }))}
          onClose={() => setDialog(null)}
          onSubmit={(destination) => {
            setFeedback(
              `样例目标：${destination.kind === 'new' ? destination.title : destination.canvasId}`,
            );
            setDialog(null);
          }}
        />
      )}
      <Modal
        isOpen={dialog === 'preview'}
        onClose={() => setDialog(null)}
        title={title}
        className="nt-dialog"
      >
        {content}
      </Modal>
    </section>
  );
}

function NodeSample({
  type,
  title,
  playing,
  layout,
  strokeWidth,
}: {
  type: CanvasNodeType;
  title: string;
  playing: boolean;
  layout: string;
  strokeWidth: number;
}) {
  if (type === 'text') return <p className="nt-text-content">{title}</p>;
  if (type === 'frame' || type === 'spacePreview')
    return (
      <>
        <div className="nt-sample-title">{title}</div>
        <div className="nt-mini-grid" data-layout={layout}>
          {['Observe', 'Connect', 'Imagine'].map((label) => (
            <div key={label}>
              <span />
              {label}
            </div>
          ))}
        </div>
      </>
    );
  if (type === 'sketch')
    return (
      <svg
        className="nt-sketch"
        viewBox="0 0 280 140"
        fill="none"
        aria-label={title}
        role="img"
      >
        <path
          d="M30 104 Q60 20 105 60 T182 56 Q226 20 250 74 M38 115 Q122 131 238 106 M120 34 L156 20 L150 48"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (type === 'question')
    return (
      <>
        <div className="nt-agent-meta">
          <MessageSquare size={18} />
          <span>Copilot</span>
          <span className={playing ? 'text-info' : 'text-fg-subtle'}>
            {playing ? '运行中' : '草稿'}
          </span>
        </div>
        <h3>{title}</h3>
      </>
    );
  if (type === 'audio')
    return (
      <>
        <div className="nt-waveform" data-playing={playing}>
          {Array.from({ length: 32 }, (_, index) => (
            <span
              key={index}
              style={{
                height: `${12 + ((index * 17 + 9) % 46)}px`,
                animationDelay: `${index * 35}ms`,
              }}
            />
          ))}
        </div>
        <div className="nt-sample-title">{title}</div>
        <div className="nt-meta">00:00 / 02:48</div>
      </>
    );
  if (type === 'image' || type === 'video')
    return (
      <div className="nt-media-sample">
        <img src={coverImage} alt={title} />
        {type === 'video' && (
          <span className="nt-media-status">
            {playing ? <Pause size={18} /> : <Play size={18} />} 00:00 / 00:32
          </span>
        )}
      </div>
    );
  if (type === 'note')
    return (
      <>
        <h3>{title}</h3>
        <p>Notice the small things.</p>
        <p>
          Collect a few unexpected connections.
          <br />
          Leave space for what comes next.
        </p>
        <div className="nt-note-rule" />
      </>
    );
  if (type === 'office')
    return (
      <>
        <div className="nt-meta">DOCX</div>
        <h3>{title}</h3>
        <div className="nt-document-lines">
          <span />
          <span />
          <span />
        </div>
      </>
    );
  return (
    <>
      <div className="nt-document-cover">
        <span>{type === 'pdf' ? 'FIELD NOTES / 2026' : 'STUDIO JOURNAL'}</span>
        <strong>
          {type === 'pdf'
            ? 'Everyday\nobservations.'
            : 'Look a little\ncloser.'}
        </strong>
      </div>
      <div className="nt-sample-title">{title}</div>
      <div className="nt-meta">
        {type === 'pdf' ? 'PDF · 24 pages' : 'journal.example.com'}
      </div>
    </>
  );
}

export default function NodeToolbarPlaygroundPage() {
  const [revision, setRevision] = useState(0);
  return (
    <main className="nt-playground">
      <header className="nt-page-header">
        <div>
          <span className="nt-eyebrow">HUABU / PLAYGROUND</span>
          <h1>Node toolbars</h1>
          <RouterLink
            to="/playground/space-previews"
            className="text-fg-muted hover:text-fg-default mt-2 inline-flex items-center gap-1 text-xs"
          >
            Space Shortcut 样式对比 <ArrowUpRight size={12} />
          </RouterLink>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRevision(revision + 1)}
        >
          <RotateCcw />
          重置样例
        </Button>
      </header>
      <section
        className="nt-state-rules"
        aria-labelledby="nt-state-rules-title"
      >
        <h2 id="nt-state-rules-title">状态规则</h2>
        <dl>
          <div>
            <dt>悬停</dt>
            <dd>普通按钮临时显示浅灰底，移开后恢复。</dd>
          </div>
          <div>
            <dt>弹层展开</dt>
            <dd>
              尺寸、布局、更多、粗细和字号持续显示浅灰底，关闭后恢复；不表示节点被选中。
            </dd>
          </div>
          <div>
            <dt>颜色</dt>
            <dd>悬停或展开时只显示色块外侧圆环，不加方形底。</dd>
          </div>
          <div>
            <dt>功能启用</dt>
            <dd>
              B/I 选中时使用主题色并略微加粗图标，不加底色；Hug
              保留强调色，键盘焦点保留独立提示。
            </dd>
          </div>
        </dl>
      </section>
      <div className="nt-gallery" key={revision}>
        {(Object.keys(TOOLBAR_SPECIMENS) as CanvasNodeType[]).map((type) => (
          <Specimen key={type} type={type} />
        ))}
      </div>
    </main>
  );
}
