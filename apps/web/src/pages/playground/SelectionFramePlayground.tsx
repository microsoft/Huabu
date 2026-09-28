// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Plus, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';

import { connectionAnchor, resizeSpecimen } from './selectionFrameGeometry';

import type {
  ResizeHandle,
  SpecimenBox,
  SpecimenKind,
} from './selectionFrameGeometry';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import './SelectionFramePlayground.css';

const INITIAL: Record<SpecimenKind, SpecimenBox> = {
  image: { x: 65, y: 90, width: 280, height: 180 },
  text: { x: 565, y: 100, width: 280, height: 100 },
  card: { x: 440, y: 350, width: 300, height: 210 },
};
const KINDS: SpecimenKind[] = ['image', 'text', 'card'];
const LABELS = { image: 'Image', text: 'Free text', card: 'Card' };
const CORNERS: ResizeHandle[] = ['tl', 'tr', 'bl', 'br'];
const WIDTH_HANDLES: ResizeHandle[] = ['left', 'right'];
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];
type Point = { x: number; y: number };
type Link = { from: SpecimenKind; to: SpecimenKind; side: Side };
type Gesture = {
  pointerId: number;
  start: Point;
  box: SpecimenBox;
  kind: SpecimenKind;
  action: 'move' | 'connect' | ResizeHandle;
};

export function SelectionFramePlayground() {
  const [boxes, setBoxes] = useState(INITIAL);
  const [selected, setSelected] = useState<SpecimenKind | null>('image');
  const [zoom, setZoom] = useState(1);
  const [fontSize, setFontSize] = useState(28);
  const [text, setText] = useState(
    'Make room for the next idea.\n把想法放在画布上。',
  );
  const [links, setLinks] = useState<Link[]>([]);
  const [connecting, setConnecting] = useState<SpecimenKind | null>(null);
  const [connectingSide, setConnectingSide] = useState<Side>('right');
  const [resizing, setResizing] = useState(false);
  const [aim, setAim] = useState<Point | null>(null);
  const [target, setTarget] = useState<SpecimenKind | null>(null);
  const [message, setMessage] = useState(
    'Select a node. Resize, move, or drag its connection dot to another node.',
  );
  const gesture = useRef<Gesture | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const textBody = useRef<HTMLDivElement>(null);
  const didDrag = useRef(false);

  useEffect(() => {
    const element = textBody.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const height = element.offsetHeight;
      setBoxes((current) =>
        current.text.height === height
          ? current
          : { ...current, text: { ...current.text, height } },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cancel = () => {
    gesture.current = null;
    setResizing(false);
    setConnecting(null);
    setAim(null);
    setTarget(null);
  };
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !stage.current?.contains(document.activeElement)
      )
        return;
      gesture.current = null;
      setResizing(false);
      setConnecting(null);
      setAim(null);
      setTarget(null);
      setMessage('Gesture cancelled.');
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, []);
  const point = (event: ReactPointerEvent): Point => {
    const rect = stage.current?.getBoundingClientRect();
    return {
      x: (event.clientX - (rect?.left ?? 0)) / zoom,
      y: (event.clientY - (rect?.top ?? 0)) / zoom,
    };
  };
  const hit = (position: Point, source: SpecimenKind) =>
    [...KINDS].reverse().find((kind) => {
      const box = boxes[kind];
      return (
        kind !== source &&
        position.x >= box.x &&
        position.x <= box.x + box.width &&
        position.y >= box.y &&
        position.y <= box.y + box.height
      );
    }) ?? null;
  const complete = (from: SpecimenKind, to: SpecimenKind) => {
    setLinks((current) =>
      current.some((link) => link.from === from && link.to === to)
        ? current
        : [...current, { from, to, side: connectingSide }],
    );
    setMessage(
      `Connected ${LABELS[from]} → ${LABELS[to]}. Escape cancels an unfinished connection.`,
    );
    cancel();
  };
  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    kind: SpecimenKind,
    action: Gesture['action'],
    side: Side = 'right',
  ) => {
    event.stopPropagation();
    if (
      event.button !== 0 ||
      gesture.current ||
      (connecting && action === 'move')
    )
      return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    didDrag.current = false;
    gesture.current = {
      pointerId: event.pointerId,
      start: point(event),
      box: boxes[kind],
      kind,
      action,
    };
    setSelected(kind);
    if (action !== 'move' && action !== 'connect') {
      setResizing(true);
      setConnecting(null);
      setAim(null);
      setTarget(null);
    }
    if (action === 'connect') {
      setConnectingSide(side);
      setConnecting(kind);
      setAim(point(event));
    }
  };
  const move = (event: ReactPointerEvent) => {
    if (gesture.current || connecting) event.stopPropagation();
    const position = point(event);
    const current = gesture.current;
    if (connecting) {
      setAim(position);
      setTarget(hit(position, connecting));
    }
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = position.x - current.start.x;
    const dy = position.y - current.start.y;
    if (Math.hypot(dx, dy) * zoom > 4) didDrag.current = true;
    if (current.action === 'connect') return;
    const next =
      current.action === 'move'
        ? {
            ...current.box,
            x: Math.max(
              20,
              Math.min(940 - current.box.width, current.box.x + dx),
            ),
            y: Math.max(
              40,
              Math.min(660 - current.box.height, current.box.y + dy),
            ),
          }
        : resizeSpecimen(current.box, current.action, dx, dy, current.kind);
    setBoxes((previous) => ({ ...previous, [current.kind]: next }));
  };
  const end = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    setResizing(false);
    if (current.action === 'connect' && didDrag.current) {
      const destination = hit(point(event), current.kind);
      if (destination) complete(current.kind, destination);
      else {
        cancel();
        setMessage(
          'No target selected. Drag the connection dot onto another node to connect.',
        );
      }
    }
  };
  const center = (kind: SpecimenKind) => ({
    x: boxes[kind].x + boxes[kind].width / 2,
    y: boxes[kind].y + boxes[kind].height / 2,
  });
  const line = (
    from: SpecimenKind,
    toward: Point,
    to?: SpecimenKind,
    side: Side = connectingSide,
  ) => {
    const box = boxes[from];
    const start = {
      x:
        side === 'left'
          ? box.x
          : side === 'right'
            ? box.x + box.width
            : box.x + box.width / 2,
      y:
        side === 'top'
          ? box.y
          : side === 'bottom'
            ? box.y + box.height
            : box.y + box.height / 2,
    };
    const endPoint = to ? connectionAnchor(boxes[to], center(from)) : toward;
    return `M ${start.x} ${start.y} L ${endPoint.x} ${endPoint.y}`;
  };

  return (
    <div
      id="selection-frame"
      className="selection-study scroll-mt-28"
      data-selection-study
      role="group"
      aria-label="Selection frame proposal"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-info text-xs font-semibold">
            INTERACTION PROPOSAL · PLAYGROUND ONLY
          </span>
          <p className="text-fg-muted mt-2 text-sm">
            选中后显示四侧外置连接点，缩放时隐藏。选中节点与控件优先接收交互，不穿透到下面的节点。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            cancel();
            setBoxes({
              ...INITIAL,
              text: {
                ...INITIAL.text,
                height: textBody.current?.offsetHeight ?? INITIAL.text.height,
              },
            });
            setSelected('image');
            setLinks([]);
            setFontSize(28);
            setText('Make room for the next idea.\n把想法放在画布上。');
            setMessage('Layout reset.');
          }}
        >
          <RotateCcw size={14} /> Reset
        </Button>
      </div>
      <div className="border-edge-default bg-surface flex flex-wrap items-center gap-3 rounded-t-xl border px-4 py-3">
        <div className="flex gap-1" aria-label="Select specimen">
          {KINDS.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={selected === kind ? 'solid' : 'ghost'}
              aria-pressed={selected === kind}
              onClick={() => {
                cancel();
                setSelected(kind);
              }}
            >
              {LABELS[kind]}
            </Button>
          ))}
        </div>
        <div className="border-edge-default h-5 border-l" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            cancel();
            setSelected('image');
            setLinks([]);
            setBoxes({
              image: { ...INITIAL.image, x: 220, y: 170 },
              text: { ...boxes.text, x: 650, y: 110 },
              card: { x: 380, y: 190, width: 300, height: 260 },
            });
            setMessage(
              'Overlap test: Image and its controls stay above Card. Resizing hides connection dots until the gesture ends.',
            );
          }}
        >
          Overlap test
        </Button>
        <Select
          ariaLabel="Study zoom"
          options={[
            { value: '0.5', label: '50%' },
            { value: '0.75', label: '75%' },
            { value: '1', label: '100%' },
          ]}
          value={String(zoom)}
          onChange={(value) => {
            cancel();
            setZoom(Number(value));
          }}
        />
        {selected === 'text' && (
          <>
            <Select
              ariaLabel="Text font size"
              options={[16, 20, 24, 28, 32, 48].map((size) => ({
                value: String(size),
                label: `${size}px`,
              }))}
              value={String(fontSize)}
              onChange={(value) => setFontSize(Number(value))}
            />
            <TextInput
              aria-label="Text specimen content"
              className="min-w-48 flex-1"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </>
        )}
        <span className="text-fg-subtle ml-auto text-xs tabular-nums">
          {selected
            ? `${Math.round(boxes[selected].width)} × ${Math.round(boxes[selected].height)}${selected === 'text' ? ` · ${fontSize}px` : ''}`
            : 'Nothing selected'}
        </span>
      </div>
      <div className="selection-study__viewport border-edge-default overflow-auto rounded-b-xl border border-t-0">
        <div
          style={{ width: 1000 * zoom, height: 700 * zoom, margin: '0 auto' }}
        >
          {/* Composite canvas owns pointer capture; its child controls provide keyboard selection, resize, and connection. */}
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          <div
            ref={stage}
            className="selection-study__stage"
            data-resize-cursor={
              resizing
                ? gesture.current?.action === 'left' ||
                  gesture.current?.action === 'right'
                  ? 'ew-resize'
                  : gesture.current?.action === 'tl' ||
                      gesture.current?.action === 'br'
                    ? 'nwse-resize'
                    : 'nesw-resize'
                : undefined
            }
            role="application"
            aria-label="Selection interaction canvas"
            tabIndex={0}
            style={
              {
                transform: `scale(${zoom})`,
                '--study-inverse': 1 / zoom,
              } as CSSProperties
            }
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                event.key === 'Escape'
              ) {
                cancel();
                setSelected(null);
              }
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                cancel();
                setSelected(null);
              }
            }}
          >
            <svg
              className="text-info pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="selection-study-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M 0 0 L 8 4 L 0 8 Z" fill="currentColor" />
                </marker>
              </defs>
              {links.map((link) => (
                <path
                  key={`${link.from}-${link.to}`}
                  data-study-link
                  d={line(link.from, center(link.to), link.to, link.side)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2 / zoom}
                  markerEnd="url(#selection-study-arrow)"
                />
              ))}
              {connecting && aim && (
                <path
                  d={line(
                    connecting,
                    target ? center(target) : aim,
                    target ?? undefined,
                  )}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2 / zoom}
                  strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                  markerEnd="url(#selection-study-arrow)"
                />
              )}
            </svg>
            {KINDS.map((kind) => {
              const box = boxes[kind];
              const active = selected === kind;
              return (
                <div
                  key={kind}
                  data-study-node={kind}
                  data-selected={active}
                  data-resizing={active && resizing}
                  data-target={target === kind}
                  className="selection-study__node absolute"
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.width,
                    height: box.height,
                  }}
                >
                  <div className="selection-study__caption text-fg-subtle">
                    {LABELS[kind]} ·{' '}
                    {kind === 'image'
                      ? '等比缩放'
                      : kind === 'text'
                        ? '调宽不改字号'
                        : '自由调整宽高'}
                  </div>
                  <div
                    ref={kind === 'text' ? textBody : undefined}
                    data-study-body={kind}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${LABELS[kind]}`}
                    className={`selection-study__body ${kind === 'text' ? 'text-fg-default' : 'bg-surface border-edge-default h-full overflow-hidden rounded-xl border'}`}
                    style={
                      kind === 'text'
                        ? {
                            fontSize,
                            lineHeight: 1.5,
                            padding: '8px 12px',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                          }
                        : undefined
                    }
                    onPointerDown={(event) => begin(event, kind, 'move')}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!didDrag.current && connecting && connecting !== kind)
                        complete(connecting, kind);
                      else setSelected(kind);
                      didDrag.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (connecting && connecting !== kind)
                          complete(connecting, kind);
                        else setSelected(kind);
                      }
                    }}
                  >
                    {kind === 'image' ? (
                      <svg
                        viewBox="0 0 280 180"
                        role="img"
                        aria-label="Landscape illustration"
                        className="h-full w-full"
                        preserveAspectRatio="xMidYMid slice"
                      >
                        <rect width="280" height="180" fill="var(--info-bg)" />
                        <circle cx="204" cy="49" r="24" fill="var(--warning)" />
                        <path
                          d="M0 147 80 47 176 180H0Z"
                          fill="var(--fg-subtle)"
                        />
                        <path
                          d="M68 180 184 72 280 154V180Z"
                          fill="var(--info)"
                        />
                        <path
                          d="M0 159 Q140 119 280 162V180H0Z"
                          fill="var(--fg-muted)"
                        />
                      </svg>
                    ) : kind === 'text' ? (
                      text || 'Your text'
                    ) : (
                      <div className="p-5">
                        <div className="text-fg-subtle text-xs">
                          WEB · DESIGN NOTES
                        </div>
                        <h3 className="text-fg-default mt-3 text-[22px] leading-snug font-semibold">
                          A quieter selection frame
                        </h3>
                        <p className="text-fg-muted mt-3 text-base leading-relaxed">
                          把连接、调宽和缩放分开。选择框保持稳定，控件只表达各自的操作。
                        </p>
                      </div>
                    )}
                  </div>
                  {active && (
                    <>
                      <div className="selection-study__outline" />
                      {(kind === 'text' ? WIDTH_HANDLES : CORNERS).map(
                        (handle) => (
                          <Button
                            key={handle}
                            variant="ghost"
                            className={`selection-study__handle selection-study__handle--${handle}`}
                            aria-label={`${LABELS[kind]} resize ${handle}`}
                            data-study-resize={handle}
                            style={{
                              cursor:
                                handle === 'left' || handle === 'right'
                                  ? 'ew-resize'
                                  : handle === 'tl' || handle === 'br'
                                    ? 'nwse-resize'
                                    : 'nesw-resize',
                            }}
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) =>
                              begin(event, kind, handle)
                            }
                            onLostPointerCapture={() => {
                              gesture.current = null;
                              setResizing(false);
                            }}
                            onKeyDown={(event) => {
                              const delta = event.shiftKey ? 10 : 2;
                              const dx =
                                event.key === 'ArrowRight'
                                  ? delta
                                  : event.key === 'ArrowLeft'
                                    ? -delta
                                    : 0;
                              const dy =
                                event.key === 'ArrowDown'
                                  ? delta
                                  : event.key === 'ArrowUp'
                                    ? -delta
                                    : 0;
                              if (dx || dy) {
                                event.preventDefault();
                                setBoxes((previous) => ({
                                  ...previous,
                                  [kind]: resizeSpecimen(
                                    previous[kind],
                                    handle,
                                    dx,
                                    dy,
                                    kind,
                                  ),
                                }));
                              }
                            }}
                          >
                            <span
                              className={
                                kind === 'text'
                                  ? 'selection-study__width-mark'
                                  : 'selection-study__corner-mark'
                              }
                            />
                          </Button>
                        ),
                      )}
                      {!resizing &&
                        SIDES.map((side) => (
                          <div
                            key={side}
                            className={`selection-study__connector selection-study__connector--${side}`}
                          >
                            <Button
                              variant="ghost"
                              tone="info"
                              iconOnly
                              className="selection-study__connect-button"
                              aria-label={`Connect from ${LABELS[kind]} ${side}`}
                              data-study-port={side}
                              aria-pressed={
                                connecting === kind && connectingSide === side
                              }
                              onPointerDown={(event) =>
                                begin(event, kind, 'connect', side)
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                if (!didDrag.current) {
                                  setConnectingSide(side);
                                  setConnecting(kind);
                                  setMessage(
                                    'Choose a target node, or press Escape to cancel.',
                                  );
                                }
                                didDrag.current = false;
                              }}
                            >
                              <span
                                className="selection-study__port-dot"
                                aria-hidden="true"
                              >
                                <Plus strokeWidth={3.5} />
                              </span>
                            </Button>
                          </div>
                        ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        </div>
      </div>
      <p className="text-fg-muted mt-3 text-xs" role="status">
        {message}
      </p>
      <div className="mt-5 grid gap-4 text-sm md:grid-cols-3">
        <div>
          <strong className="text-fg-default">01 · Stable connection</strong>
          <p className="text-fg-muted mt-1">
            选中后四侧各一个实心点，距边框 24
            屏幕像素。缩放期间全部隐藏，松开或取消后恢复。从哪侧拖出，就从哪侧连线；暂不模拟点击新建节点。
          </p>
        </div>
        <div>
          <strong className="text-fg-default">
            02 · Shape-specific handles
          </strong>
          <p className="text-fg-muted mt-1">
            图片四角等比；文字仅左右调宽；卡片四角自由缩放。没有隐藏的边缘拉伸热区。
          </p>
        </div>
        <div>
          <strong className="text-fg-default">03 · Selected node first</strong>
          <p className="text-fg-muted mt-1">
            选中节点与外置控件整体置顶，拖动全程由起始控件捕获指针。点 Overlap
            test 验证不会误选或拖动下面的节点。50% 缩放时控件仍保持屏幕尺寸。
          </p>
        </div>
      </div>
    </div>
  );
}
