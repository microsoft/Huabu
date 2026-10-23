// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import '@fontsource/caveat/latin-400.css';
import 'lxgw-wenkai-lite-webfont/lxgwwenkailite-regular.css';
import '@/components/Common/scrollbar.css';

import { useViewport, ViewportPortal } from '@xyflow/react';
import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { resolveAccent } from '@huabu/shared';
import {
  getAbsolutePosition,
  getInkSigilStrokes,
  INK_SIGIL_LABEL_MAX_WIDTH,
  INK_SIGIL_LABEL_LINE_HEIGHT,
  inkResourceLabel,
  inkSigilBounds,
  inkSigilFingerprint,
  inkSigilLayout,
  isInkResourceType,
  projectInkResourceBindings,
} from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import { cn } from '@/components/Common/cn';
import { TabGroup } from '@/components/Common/TabGroup';
import { toast } from '@/components/Common/Toast';
import { applyNodeGeometryPreviews } from '@/components/Panels/Canvas/applyNodeGeometryPreview';
import { canvasNodeZOrder } from '@/components/Panels/Canvas/selectionZOrder';
import { getNodeIcon } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import {
  bindPendingInkSigil,
  dismissInkSigil,
  reopenInkSigil,
  resetInkSigilSession,
  useInkSigilStore,
  validatePendingInkSigil,
} from '@/store/inkSigilStore';
import { useToolStore } from '@/store/toolStore';
import { INK_HANDWRITING_FONT_FAMILY } from '@/utils/node/nodeFontConfig';

import { useInkSigilHighlightHost } from './InkSigilHighlightHost';
import { useInkSigilDrag } from './useInkSigilDrag';
import { useFrameSuppressed } from '../frame/FrameZoomContext';

import type { CanvasNode } from '@/components/Nodes/types';
import type { CanvasTool } from '@/components/Panels/Canvas/canvasInputPolicy';
import type {
  InkSigilProjection,
  InkSigilStroke,
} from '@huabu/shared/canvas-engine';
import type { Node, XYPosition } from '@xyflow/react';

const RESOURCE_CATEGORIES = ['pdf', 'web', 'image', 'text'] as const;
type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

function ResourceList({
  nodes,
  label,
  scrollRef,
  scrollTop,
}: {
  nodes: Node[];
  label: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollTop: number;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const rowHeight = 28;
  const index = Math.min(active, Math.max(0, nodes.length - 1));
  const listTop = ref.current?.offsetTop ?? 0;
  const first = Math.min(
    nodes.length,
    Math.max(0, Math.floor((scrollTop - listTop) / rowHeight) - 2),
  );
  const last = Math.min(nodes.length, first + 12);
  const indices = Array.from({ length: last - first }, (_, i) => first + i);
  if (nodes.length && !indices.includes(index)) indices.push(index);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const list = ref.current;
    if (!element || !list || document.activeElement !== list) return;
    const top = list.offsetTop + index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  }, [index, scrollRef]);
  if (!nodes.length)
    return (
      <p className="text-fg-muted px-2 py-3 text-xs" role="status">
        {t('sigil.noResources')}
      </p>
    );
  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={`${listId}-${index}`}
      className="group/sigil-resources outline-none"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(
            Math.max(
              0,
              Math.min(
                nodes.length - 1,
                index + (event.key === 'ArrowDown' ? 1 : -1),
              ),
            ),
          );
        } else if (event.key === 'Enter') {
          event.preventDefault();
          void bindPendingInkSigil(nodes[index].id);
        }
      }}
    >
      <div
        role="presentation"
        style={{ height: nodes.length * rowHeight - 4, position: 'relative' }}
      >
        {indices.map((i) => {
          const node = nodes[i];
          const Icon = getNodeIcon(node.type, node.data);
          const name = inkResourceLabel(node);
          return (
            <Button
              key={node.id}
              id={`${listId}-${i}`}
              variant="ghost"
              size="sm"
              role="option"
              aria-selected={index === i}
              aria-posinset={i + 1}
              aria-setsize={nodes.length}
              tabIndex={-1}
              className={cn(
                'w-full justify-start overflow-hidden',
                index === i && 'group-focus-visible/sigil-resources:bg-hover',
              )}
              style={{
                position: 'absolute',
                top: i * rowHeight,
                height: rowHeight - 4,
                width: '100%',
              }}
              title={`${name} (${node.id})`}
              onMouseEnter={() => setActive(i)}
              onClick={() => void bindPendingInkSigil(node.id)}
            >
              <Icon aria-hidden />
              <span className="truncate">{name}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function InkSigilLayer({ tool = 'select' }: { tool?: CanvasTool }) {
  const viewport = useViewport();
  const nodes = useCanvasStore((state) => state.nodes);
  const selection = useGesturePreviewStore(
    (state) => state.sketchStrokeSelection,
  );
  const move = useGesturePreviewStore((state) => state.sketchStrokeMovePreview);
  const carried = useGesturePreviewStore(
    (state) => state.sketchStrokeMoveCarriedNodeIds,
  );
  const erased = useGesturePreviewStore((state) => state.sketchErasePreview);
  const geometries = useGesturePreviewStore(
    (state) => state.nodeGeometryPreviews,
  );
  const canvasId = useCanvasStore((state) => state.canvasId);
  const pending = useInkSigilStore((state) => state.pending);
  const pendingNodeType = useToolStore((state) => state.pendingNodeType);
  const mode = useToolStore((state) => state.sketchDraft.mode);
  const drawing = pendingNodeType === 'sketch' && mode === 'draw';
  const interactive =
    tool === 'select' && (pendingNodeType === null || drawing);
  const drag = useInkSigilDrag(nodes, canvasId, interactive);
  const projections = useMemo(() => projectInkResourceBindings(nodes), [nodes]);
  const zIndices = useMemo(
    () => canvasNodeZOrder(nodes, tool, pendingNodeType),
    [nodes, tool, pendingNodeType],
  );
  const displayNodes = useMemo(
    () => applyNodeGeometryPreviews(nodes as CanvasNode[], geometries),
    [nodes, geometries],
  );
  const hiddenNodeIds = useMemo(
    () => new Set(nodes.filter((node) => node.hidden).map((node) => node.id)),
    [nodes],
  );
  const displayedStrokes = useMemo(() => {
    if (!geometries?.size) return null;
    const ids = new Set(
      projections.flatMap((projection) => projection.binding.strokeIds),
    );
    return new Map(
      getInkSigilStrokes(displayNodes, ids).map((source) => [
        source.stroke.id,
        source,
      ]),
    );
  }, [displayNodes, geometries, projections]);
  const pendingSources = useMemo(() => {
    if (!pending) return [];
    const ids = new Set(pending.strokeIds);
    return getInkSigilStrokes(displayNodes, ids);
  }, [displayNodes, pending]);
  const pendingSuppressed = useFrameSuppressed(
    pendingSources.map((source) => source.nodeId),
  );
  const pendingHidden =
    pendingSuppressed ||
    pendingSources.some((source) => hiddenNodeIds.has(source.nodeId));

  useEffect(() => {
    resetInkSigilSession();
    return resetInkSigilSession;
  }, [canvasId]);
  useEffect(() => {
    dismissInkSigil();
  }, [tool, pendingNodeType, mode]);
  useEffect(() => {
    if (pending && (pendingHidden || !validatePendingInkSigil()))
      dismissInkSigil();
  }, [nodes, pending, pendingHidden]);

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-5 overflow-hidden">
        <div
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {projections.map((projection) => {
            if (
              projection.sources.some((source) =>
                hiddenNodeIds.has(source.nodeId),
              )
            )
              return null;
            const selectedCount = projection.sources.filter((source) =>
              selection[source.nodeId]?.includes(source.stroke.id),
            ).length;
            if (move && selectedCount > 0 && selectedCount < 4) return null;
            if (
              projection.sources.some((source) =>
                erased[source.nodeId]?.includes(source.stroke.id),
              )
            )
              return null;
            const moveSource = (source: InkSigilStroke): InkSigilStroke =>
              move && selectedCount === 4 && !carried.includes(source.nodeId)
                ? {
                    ...source,
                    points: source.points.map(([x, y]) => [
                      x + move.dx,
                      y + move.dy,
                    ]),
                  }
                : source;
            const sourceValid =
              move && selectedCount === 4
                ? inkSigilFingerprint(projection.sources.map(moveSource)) ===
                  projection.binding.fingerprint
                : projection.sourceValid;
            if (!sourceValid) return null;
            const display = {
              ...projection,
              sourceValid,
              bounds: inkSigilBounds(
                projection.sources.map((source) =>
                  moveSource(displayedStrokes?.get(source.stroke.id) ?? source),
                ),
              ),
            };
            const highlightNodeId = projection.sources.reduce(
              (lowest, source) =>
                (zIndices.get(source.nodeId) ?? Infinity) <
                (zIndices.get(lowest.nodeId) ?? Infinity)
                  ? source
                  : lowest,
            ).nodeId;
            const highlightOrigin = getAbsolutePosition(
              displayNodes,
              highlightNodeId,
            );
            if (!highlightOrigin) {
              throw new Error(
                `[ink-sigil] Missing highlight owner: ${highlightNodeId}`,
              );
            }
            return (
              <InkSigilAnnotation
                key={projection.binding.id}
                projection={display}
                interactive={interactive}
                drag={drag}
                selected={selectedCount === 4}
                zoom={viewport.zoom}
                highlightNodeId={highlightNodeId}
                highlightOrigin={highlightOrigin}
                highlightZ={zIndices.get(highlightNodeId) ?? 0}
                picker={
                  pending?.canvasId === canvasId &&
                  pending.bindingId === projection.binding.id
                    ? { nodes }
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>
      {pending &&
      !pending.bindingId &&
      pending.canvasId === canvasId &&
      !pendingHidden &&
      pendingSources.length === 4 ? (
        <InkResourcePicker
          key={`${pending.fingerprint}-${pending.bindingId ?? 'new'}`}
          nodes={nodes}
          anchor={inkSigilBounds(pendingSources)}
        />
      ) : null}
    </>
  );
}

function InkSigilAnnotation({
  projection,
  selected,
  interactive,
  drag,
  zoom,
  highlightNodeId,
  highlightOrigin,
  highlightZ,
  picker,
}: {
  projection: InkSigilProjection;
  selected: boolean;
  interactive: boolean;
  drag: ReturnType<typeof useInkSigilDrag>;
  zoom: number;
  highlightNodeId: string;
  highlightOrigin: XYPosition;
  highlightZ: number;
  picker?: { nodes: Node[] };
}) {
  const { t } = useTranslation();
  const highlightLayer = useInkSigilHighlightHost(highlightNodeId);
  const frameSuppressed = useFrameSuppressed(
    projection.sources.map((source) => source.nodeId),
  );
  const text = useRef<HTMLSpanElement>(null);
  const [labelSize, setLabelSize] = useState<{
    width: number;
    height: number;
  }>();
  const layout = inkSigilLayout(
    projection.bounds,
    labelSize?.width,
    labelSize?.height,
  );
  const broken = !projection.target;
  useLayoutEffect(() => {
    if (frameSuppressed) return;
    const element = text.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = rect.width / zoom;
      const height = rect.height / zoom;
      if (width > 0 && height > 0) {
        setLabelSize((previous) =>
          previous?.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (document.fonts) {
      void document.fonts
        .load(
          `${layout.fontSize}px ${INK_HANDWRITING_FONT_FAMILY}`,
          projection.label,
        )
        .then(
          () => {
            if (active) measure();
          },
          (error: unknown) => {
            console.error('[ink-sigil] handwriting font load failed', error);
            if (active) toast(t('sigil.fontsUnavailable'), { tone: 'danger' });
          },
        );
    }
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [zoom, projection.label, layout.fontSize, broken, frameSuppressed, t]);
  if (frameSuppressed) return null;
  const highlight = (
    <div
      inert
      data-ink-sigil-highlight
      data-canvas-grounding-exclude={
        projection.target && selected ? undefined : ''
      }
      className={
        broken
          ? 'bg-warning-bg-hover/70 pointer-events-none absolute rounded'
          : 'bg-ink-reference-highlight/70 pointer-events-none absolute rounded'
      }
      style={{
        left:
          layout.semanticBounds.x - (highlightLayer ? highlightOrigin.x : 0),
        top: layout.semanticBounds.y - (highlightLayer ? highlightOrigin.y : 0),
        width: layout.semanticBounds.width,
        height: layout.semanticBounds.height,
        // ViewportPortal follows the node renderer in DOM order, so a tie
        // paints above the preceding node and below the absent source.
        zIndex: highlightLayer ? undefined : highlightZ - 1,
      }}
    />
  );
  return (
    <div
      data-ink-sigil={projection.binding.id}
      data-ink-sigil-label-width={layout.labelWidth}
      data-ink-sigil-label-height={layout.labelHeight}
      data-canvas-grounding-exclude={
        projection.target && selected ? undefined : ''
      }
    >
      {highlightLayer ? (
        createPortal(highlight, highlightLayer)
      ) : (
        <ViewportPortal>{highlight}</ViewportPortal>
      )}
      <Button
        variant="ghost"
        data-ink-sigil-hit-target
        data-canvas-grounding-exclude
        tabIndex={-1}
        aria-label={t(broken ? 'sigil.repair' : 'sigil.changeResource', {
          label: projection.label,
        })}
        className={`absolute touch-none bg-transparent p-0 select-none enabled:hover:bg-transparent ${interactive ? 'pointer-events-auto cursor-grab active:cursor-grabbing' : 'pointer-events-none'}`}
        style={{
          left: projection.bounds.x,
          top: projection.bounds.y,
          width: projection.bounds.width,
          height: projection.bounds.height,
        }}
        {...drag}
        onPointerDown={(event) => drag.onPointerDown(event, projection)}
        onClick={(event) => {
          event.stopPropagation();
          if (interactive && event.detail === 0) reopenInkSigil(projection);
        }}
      >
        {null}
      </Button>
      <Button
        variant="ghost"
        data-ink-sigil-label
        className={`absolute touch-none justify-start overflow-hidden rounded-none bg-transparent p-0 text-left font-normal select-none enabled:hover:bg-transparent ${broken ? 'text-warning' : 'text-fg-default'} ${interactive ? 'pointer-events-auto cursor-grab active:cursor-grabbing' : 'pointer-events-none'}`}
        tabIndex={interactive ? 0 : -1}
        style={{
          left: layout.labelX,
          top: layout.labelY,
          fontSize: layout.fontSize,
          fontFamily: INK_HANDWRITING_FONT_FAMILY,
          color: broken
            ? undefined
            : (resolveAccent(projection.sources[0].stroke.color) ??
              projection.sources[0].stroke.color),
          lineHeight: INK_SIGIL_LABEL_LINE_HEIGHT,
        }}
        title={projection.label}
        aria-label={t(broken ? 'sigil.repair' : 'sigil.changeResource', {
          label: projection.label,
        })}
        {...drag}
        onPointerDown={(event) => drag.onPointerDown(event, projection)}
        onClick={(event) => {
          event.stopPropagation();
          if (interactive && event.detail === 0) reopenInkSigil(projection);
        }}
      >
        <span
          ref={text}
          className="line-clamp-2 wrap-anywhere"
          style={{ width: 'max-content', maxWidth: INK_SIGIL_LABEL_MAX_WIDTH }}
        >
          {broken ? `${t('sigil.missing')}: ` : ''}
          {projection.label}
        </span>
      </Button>
      {picker ? (
        <InkResourcePicker
          nodes={picker.nodes}
          anchor={layout.semanticBounds}
          currentLabel={projection.label}
          currentCategory={
            projection.binding.targetType === 'note'
              ? 'text'
              : projection.binding.targetType
          }
        />
      ) : null}
    </div>
  );
}

function InkResourcePicker({
  nodes,
  anchor,
  currentLabel,
  currentCategory,
}: {
  nodes: Node[];
  anchor: { x: number; y: number; width: number; height: number };
  currentLabel?: string;
  currentCategory?: ResourceCategory;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const panelId = useId();
  const groups = useMemo(() => {
    const result: Record<ResourceCategory, Node[]> = {
      pdf: [],
      web: [],
      image: [],
      text: [],
    };
    for (const node of nodes) {
      if (isInkResourceType(node.type))
        result[node.type === 'note' ? 'text' : node.type].push(node);
    }
    return result;
  }, [nodes]);
  const availableCategories = RESOURCE_CATEGORIES.filter(
    (key) => groups[key].length > 0,
  );
  const [category, setCategory] = useState<ResourceCategory | null>(
    () => currentCategory ?? availableCategories[0] ?? null,
  );
  const availableCategory =
    category && groups[category].length > 0
      ? category
      : (availableCategories[0] ?? null);
  if (category !== availableCategory) {
    setCategory(availableCategory);
    setScrollTop(0);
  }
  const categoryLabel = category
    ? t(`sigil.categories.${category}`)
    : t('sigil.chooseResource');
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismissInkSigil();
    };
    document.addEventListener('keydown', onKey, true);
    const onOutsidePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-ink-sigil-picker], .react-flow')
      )
        dismissInkSigil();
    };
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open
      side="bottom"
      offset={6}
      className="border-edge-default bg-surface flex max-h-[var(--canvas-popover-available-height,calc(100dvh-16px))] w-72 max-w-[var(--canvas-popover-available-width,calc(100vw-16px))] flex-col rounded-md border p-2 shadow-lg"
    >
      <div
        role="dialog"
        ref={dialog}
        tabIndex={-1}
        aria-label={t('sigil.chooseResource')}
        data-ink-sigil-picker
        className="flex min-h-0 min-w-0 flex-col outline-none"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2 pl-1">
          <span className="text-fg-muted text-xs">
            {t('sigil.bindingHint')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('sigil.close')}
            onClick={dismissInkSigil}
          >
            <X />
          </Button>
        </div>
        {currentLabel ? (
          <p className="sr-only">
            {t('sigil.currentResource', { label: currentLabel })}
          </p>
        ) : null}
        {category ? (
          <TabGroup
            options={availableCategories.map((value) => {
              const Icon = getNodeIcon(value);
              return {
                value,
                label: t(`sigil.categories.${value}`),
                icon: <Icon />,
              };
            })}
            value={category}
            onChange={(value) => {
              if (value === category) return;
              setCategory(value);
              setScrollTop(0);
            }}
            aria-label={t('sigil.resourceCategories')}
            panelId={panelId}
            size="sm"
            className="mb-2 shrink-0 flex-wrap [&>button]:h-8 [&>button]:w-[50px] [&>button]:flex-none [&>button]:gap-0.5 [&>button]:px-0 [&>button]:text-[11px] [&>button_svg]:size-3"
          />
        ) : null}
        <div
          key={category ?? 'empty'}
          id={panelId}
          role={category ? 'tabpanel' : undefined}
          aria-label={category ? categoryLabel : undefined}
          tabIndex={category ? undefined : 0}
          ref={scrollRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="huabu-scrollbar relative max-h-64 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          <ResourceList
            nodes={category ? groups[category] : []}
            label={categoryLabel}
            scrollRef={scrollRef}
            scrollTop={scrollTop}
          />
        </div>
      </div>
    </CanvasFloatingPopover>
  );
}
