import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  PenLine,
  Play,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import useCanvasStore from '../../store/canvasStore';
import { useIntentStore } from '../../store/intentStore';
import { Button } from '../Common/Button';
import { IconButton } from '../Common/IconButton';

import type { IntentAction } from '@sediment/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of placeholder IDs ($0, $1, …) to human-readable labels
 * by scanning the actions list for ADD_NODE ops in order.
 */
function buildTempIdMap(actions: IntentAction[]): Map<string, string> {
  const map = new Map<string, string>();
  let idx = 0;
  for (const a of actions) {
    if (a.op === 'ADD_NODE') {
      const placeholder = `$${idx}`;
      const label = a.label ? `New "${a.label}"` : `New ${a.nodeType} $${idx}`;
      map.set(placeholder, label);
      idx++;
    }
  }
  return map;
}

/** Get a human-readable label for a node id, checking temp IDs first. */
function nodeNameWithTemp(id: string, tempMap: Map<string, string>): string {
  const temp = tempMap.get(id);
  if (temp) return temp;
  const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
  return (
    ((node?.data as Record<string, unknown>)?.label as string) || id.slice(0, 8)
  );
}

/** All canvas nodes + temp nodes as { id, label } pairs for the picker. */
function allNodeOptionsWithTemp(
  tempMap: Map<string, string>,
): Array<{ id: string; label: string }> {
  const real = useCanvasStore.getState().nodes.map((n) => ({
    id: n.id,
    label:
      ((n.data as Record<string, unknown>)?.label as string) ||
      n.id.slice(0, 8),
  }));
  const temp = Array.from(tempMap.entries()).map(([id, label]) => ({
    id,
    label,
  }));
  return [...temp, ...real];
}

// ---------------------------------------------------------------------------
// Stage Dots (clickable)
// ---------------------------------------------------------------------------
// Step 1: Intent Selection (hover to preview, click to select)
// ---------------------------------------------------------------------------

const IntentSelectStep: React.FC<{ anchorY: number }> = ({ anchorY }) => {
  const candidates = useIntentStore((s) => s.candidates);
  const selectedIndex = useIntentStore((s) => s.selectedIndex);
  const customIntent = useIntentStore((s) => s.customIntent);
  const isStreaming = useIntentStore((s) => s.isStreaming);
  const selectCandidate = useIntentStore((s) => s.selectCandidate);
  const submitCustomIntent = useIntentStore((s) => s.submitCustomIntent);
  const setCustomIntent = useIntentStore((s) => s.setCustomIntent);

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine whether description should expand upward or downward
  // based on the item's position relative to viewport center and anchor.
  const shouldExpandUp = useCallback(
    (idx: number): boolean => {
      const el = itemRefs.current.get(idx);
      if (!el) return anchorY > window.innerHeight / 2;
      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      return spaceBelow < 60;
    },
    [anchorY],
  );

  const handleCustomSubmit = useCallback(() => {
    if (customIntent.trim()) {
      void submitCustomIntent(customIntent.trim());
    }
  }, [customIntent, submitCustomIntent]);

  return (
    <div className="flex flex-col">
      {candidates.length === 0 && !isStreaming ? (
        <div className="text-muted-foreground px-3 py-4 text-sm">
          No suggestions available.
        </div>
      ) : (
        <ul className="my-1 flex flex-col">
          {candidates.map((c, idx) => {
            const isSelected = selectedIndex === idx;
            const isHovered = hoveredIdx === idx;
            const expandUp = isHovered && shouldExpandUp(idx);

            return (
              <li
                key={idx}
                ref={(el) => {
                  if (el) itemRefs.current.set(idx, el);
                  else itemRefs.current.delete(idx);
                }}
                className="relative"
              >
                <button
                  type="button"
                  className={`mx-2 flex w-[calc(100%-16px)] cursor-pointer flex-col rounded-md px-2 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-theme-100' : isHovered ? 'bg-muted' : ''
                  }`}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onClick={() => void selectCandidate(idx)}
                >
                  {/* Description above label when expanding up */}
                  {isHovered && expandUp && c.description && (
                    <span className="text-muted-foreground mb-0.5 text-xs leading-snug">
                      {c.description}
                    </span>
                  )}
                  <span className="text-foreground text-sm">{c.label}</span>
                  {/* Description below label when expanding down */}
                  {isHovered && !expandUp && c.description && (
                    <span className="text-muted-foreground mt-0.5 text-xs leading-snug">
                      {c.description}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {isStreaming && (
            <li className="text-muted-foreground flex items-center gap-1.5 px-4 py-1.5 text-xs">
              <Loader2 size={12} className="animate-spin" />
              <span>Thinking…</span>
            </li>
          )}
        </ul>
      )}

      {/* Custom intent input */}
      <div className="border-border border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PenLine
            size={12}
            className="text-muted-foreground/60 flex-shrink-0"
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Describe your intent…"
            className="text-foreground placeholder:text-muted-foreground/50 w-full bg-transparent text-sm outline-none"
            value={customIntent}
            onChange={(e) => setCustomIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomSubmit();
            }}
          />
          <IconButton
            type="button"
            title="Send"
            className="text-muted-foreground hover:text-theme-500 flex-shrink-0 transition-colors disabled:opacity-30"
            disabled={!customIntent.trim()}
            onClick={handleCustomSubmit}
          >
            <Send size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Node Picker Dropdown (inline, for editable action params)
// ---------------------------------------------------------------------------

const NodePicker: React.FC<{
  pickerId: string;
  activePickerId: string | null;
  setActivePickerId: React.Dispatch<React.SetStateAction<string | null>>;
  currentId: string;
  onChange: (newId: string) => void;
  tempMap: Map<string, string>;
}> = ({
  pickerId,
  activePickerId,
  setActivePickerId,
  currentId,
  onChange,
  tempMap,
}) => {
  const options = useMemo(() => allNodeOptionsWithTemp(tempMap), [tempMap]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = activePickerId === pickerId;

  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 176;
    const gap = 6;
    const estimatedHeight = Math.min(options.length * 28 + 8, 192);
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const openUp = spaceBelow < Math.min(estimatedHeight, 120);

    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - menuWidth - 8),
    );

    setMenuStyle({
      position: 'fixed',
      left,
      top: openUp ? undefined : rect.bottom + gap,
      bottom: openUp ? window.innerHeight - rect.top + gap : undefined,
      width: menuWidth,
      maxHeight: 192,
      zIndex: 10001,
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();

    const handleViewportChange = () => updateMenuPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setActivePickerId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActivePickerId(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, setActivePickerId]);

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        className="bg-muted hover:bg-muted/80 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium transition-colors"
        onClick={() =>
          setActivePickerId((current) =>
            current === pickerId ? null : pickerId,
          )
        }
      >
        {nodeNameWithTemp(currentId, tempMap)}
        <ChevronDown size={10} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="border-border overflow-y-auto rounded-md border bg-white shadow-lg"
            style={menuStyle}
          >
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`hover:bg-muted flex w-full cursor-pointer px-2 py-1 text-left text-xs ${
                  opt.id === currentId ? 'bg-theme-50 font-medium' : ''
                }`}
                onClick={() => {
                  onChange(opt.id);
                  setActivePickerId(null);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Single action line renderer (used inside grouped sections)
// ---------------------------------------------------------------------------

const ActionLine: React.FC<{
  action: IntentAction;
  globalIndex: number;
  addNodeIndex: number;
  tempMap: Map<string, string>;
  activePickerId: string | null;
  setActivePickerId: React.Dispatch<React.SetStateAction<string | null>>;
  onUpdate: (index: number, updated: IntentAction) => void;
}> = ({
  action,
  globalIndex,
  addNodeIndex,
  tempMap,
  activePickerId,
  setActivePickerId,
  onUpdate,
}) => {
  const pickerId = useCallback(
    (field: string) => `${globalIndex}:${field}`,
    [globalIndex],
  );

  const content = (() => {
    switch (action.op) {
      case 'ADD_NODE':
        return (
          <span>
            <strong>{action.nodeType}</strong>
            {action.label ? ` "${action.label}"` : ''}{' '}
            <span className="text-muted-foreground font-mono text-[10px]">
              {'$'}
              {addNodeIndex}
            </span>
          </span>
        );
      case 'DELETE_NODES':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            {action.nodeIds.map((id, i) => (
              <React.Fragment key={i}>
                {i > 0 && ', '}
                <NodePicker
                  pickerId={pickerId(`delete:${i}`)}
                  activePickerId={activePickerId}
                  setActivePickerId={setActivePickerId}
                  currentId={id}
                  tempMap={tempMap}
                  onChange={(newId) => {
                    const next = [...action.nodeIds];
                    next[i] = newId;
                    onUpdate(globalIndex, { ...action, nodeIds: next });
                  }}
                />
              </React.Fragment>
            ))}
          </span>
        );
      case 'CONNECT':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('connect:source')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.sourceId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, sourceId: newId })
              }
            />{' '}
            →{' '}
            <NodePicker
              pickerId={pickerId('connect:target')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.targetId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, targetId: newId })
              }
            />
          </span>
        );
      case 'DISCONNECT':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('disconnect:source')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.sourceId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, sourceId: newId })
              }
            />{' '}
            ↛{' '}
            <NodePicker
              pickerId={pickerId('disconnect:target')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.targetId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, targetId: newId })
              }
            />
          </span>
        );
      case 'UPDATE_NODE_DATA':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('update-node')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.nodeId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, nodeId: newId })
              }
            />
          </span>
        );
      case 'GROUP_INTO_FRAME':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            {action.nodeIds.map((id, i) => (
              <React.Fragment key={i}>
                {i > 0 && ', '}
                <NodePicker
                  pickerId={pickerId(`group:${i}`)}
                  activePickerId={activePickerId}
                  setActivePickerId={setActivePickerId}
                  currentId={id}
                  tempMap={tempMap}
                  onChange={(newId) => {
                    const next = [...action.nodeIds];
                    next[i] = newId;
                    onUpdate(globalIndex, { ...action, nodeIds: next });
                  }}
                />
              </React.Fragment>
            ))}
            {action.frameLabel ? ` → "${action.frameLabel}"` : ''}
          </span>
        );
      case 'UNFRAME':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('unframe')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.frameId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, frameId: newId })
              }
            />
          </span>
        );
      case 'MOVE_INTO_FRAME':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('move-into:node')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.nodeId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, nodeId: newId })
              }
            />{' '}
            → frame{' '}
            <NodePicker
              pickerId={pickerId('move-into:frame')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.frameId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, frameId: newId })
              }
            />
          </span>
        );
      case 'MOVE_OUT_OF_FRAME':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('move-out')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.nodeId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdate(globalIndex, { ...action, nodeId: newId })
              }
            />
          </span>
        );
      case 'SELECT_NODES':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            {action.nodeIds.map((id, i) => (
              <React.Fragment key={i}>
                {i > 0 && ', '}
                <NodePicker
                  pickerId={pickerId(`select:${i}`)}
                  activePickerId={activePickerId}
                  setActivePickerId={setActivePickerId}
                  currentId={id}
                  tempMap={tempMap}
                  onChange={(newId) => {
                    const next = [...action.nodeIds];
                    next[i] = newId;
                    onUpdate(globalIndex, { ...action, nodeIds: next });
                  }}
                />
              </React.Fragment>
            ))}
          </span>
        );
      case 'ALIGN_NODES':
        return <span>{action.direction}</span>;
      case 'SPREAD_NODES':
        return <span>spread apart</span>;
    }
  })();

  return (
    <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
      {content}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Action grouping — groups consecutive same-op actions into sections
// ---------------------------------------------------------------------------

interface ActionGroup {
  key: string;
  label: string;
  indices: number[];
}

function buildActionGroups(
  actions: IntentAction[],
  _tempMap: Map<string, string>,
): ActionGroup[] {
  const groups: ActionGroup[] = [];
  let i = 0;
  while (i < actions.length) {
    const op = actions[i].op;
    const indices: number[] = [];
    while (i < actions.length && actions[i].op === op) {
      indices.push(i);
      i++;
    }

    let label: string;
    switch (op) {
      case 'ADD_NODE':
        label =
          indices.length === 1
            ? 'Create node'
            : `Create ${indices.length} nodes`;
        break;
      case 'CONNECT':
        label =
          indices.length === 1
            ? 'Connect edge'
            : `Connect ${indices.length} edges`;
        break;
      case 'DISCONNECT':
        label =
          indices.length === 1
            ? 'Disconnect edge'
            : `Disconnect ${indices.length} edges`;
        break;
      case 'DELETE_NODES': {
        const total = indices.reduce((sum, gi) => {
          const a = actions[gi] as Extract<
            IntentAction,
            { op: 'DELETE_NODES' }
          >;
          return sum + a.nodeIds.length;
        }, 0);
        label = total === 1 ? 'Delete node' : `Delete ${total} nodes`;
        break;
      }
      case 'UPDATE_NODE_DATA':
        label =
          indices.length === 1
            ? 'Update node'
            : `Update ${indices.length} nodes`;
        break;
      case 'GROUP_INTO_FRAME':
        label = 'Group into frame';
        break;
      case 'UNFRAME':
        label = 'Dissolve frame';
        break;
      case 'MOVE_INTO_FRAME':
        label = 'Move into frame';
        break;
      case 'MOVE_OUT_OF_FRAME':
        label = 'Remove from frame';
        break;
      case 'SELECT_NODES':
        label = 'Select nodes';
        break;
      case 'ALIGN_NODES':
        label = 'Align nodes';
        break;
      case 'SPREAD_NODES':
        label = 'Spread nodes';
        break;
      default:
        label = 'Action';
    }

    groups.push({ key: `${op}-${indices[0]}`, label, indices });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Step 2: Action Review — collapsible grouped list
// ---------------------------------------------------------------------------

const ActionReviewStep: React.FC = () => {
  const actions = useIntentStore((s) => s.actions);
  const updateAction = useIntentStore((s) => s.updateAction);
  const resetActions = useIntentStore((s) => s.resetActions);
  const execute = useIntentStore((s) => s.execute);

  const tempMap = useMemo(() => buildTempIdMap(actions), [actions]);
  const groups = useMemo(
    () => buildActionGroups(actions, tempMap),
    [actions, tempMap],
  );

  const addNodeIndices = useMemo(() => {
    const indices: number[] = [];
    let counter = 0;
    for (const a of actions) {
      indices.push(a.op === 'ADD_NODE' ? counter++ : -1);
    }
    return indices;
  }, [actions]);

  // All groups expanded by default
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activePickerId, setActivePickerId] = useState<string | null>(null);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    setActivePickerId(null);
  }, [actions]);

  return (
    <div className="flex flex-col">
      {actions.length === 0 ? (
        <div className="text-muted-foreground px-3 py-4 text-sm">
          No actions generated.
        </div>
      ) : (
        <div className="flex flex-col py-1">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);

            return (
              <div key={group.key}>
                {/* Group header — click to toggle */}
                <button
                  type="button"
                  className="hover:bg-muted mx-2 flex w-[calc(100%-16px)] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
                  onClick={() => toggleGroup(group.key)}
                >
                  <ChevronRight
                    size={11}
                    className={`text-muted-foreground/50 flex-shrink-0 transition-transform ${
                      !isCollapsed ? 'rotate-90' : ''
                    }`}
                  />
                  <span className="text-foreground/80">{group.label}</span>
                </button>
                {/* Expanded action lines */}
                {!isCollapsed &&
                  group.indices.map((gi) => (
                    <ActionLine
                      key={gi}
                      action={actions[gi]}
                      globalIndex={gi}
                      addNodeIndex={addNodeIndices[gi]}
                      tempMap={tempMap}
                      activePickerId={activePickerId}
                      setActivePickerId={setActivePickerId}
                      onUpdate={updateAction}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Action bar */}
      <div className="border-border flex items-center justify-between border-t px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground hover:bg-muted gap-1"
          onClick={resetActions}
        >
          <RotateCcw size={12} />
          Reset
        </Button>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="bg-muted hover:bg-muted/80 text-foreground/70 gap-1 rounded-md px-3 py-1"
          >
            <Pencil size={10} />
            Edit
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="gap-1 rounded-md px-3 py-1"
            onClick={execute}
          >
            <Play size={10} />
            Execute
          </Button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// IntentPopover (main)
//
// Positioning: anchored by BOTTOM edge via CSS `bottom`. Content grows
// upward — no jitter. maxHeight prevents overflow above viewport.
// ---------------------------------------------------------------------------

const POPOVER_WIDTH = 320;
const MARGIN = 12;
const GAP = 12;

export const IntentPopover: React.FC = () => {
  const isOpen = useIntentStore((s) => s.isOpen);
  const isLoading = useIntentStore((s) => s.isLoading);
  const step = useIntentStore((s) => s.step);
  const position = useIntentStore((s) => s.position);
  const dismiss = useIntentStore((s) => s.dismiss);
  const goBack = useIntentStore((s) => s.goBack);
  const selectedIndex = useIntentStore((s) => s.selectedIndex);
  const candidates = useIntentStore((s) => s.candidates);
  const customIntent = useIntentStore((s) => s.customIntent);

  const containerRef = useRef<HTMLDivElement>(null);
  const [xPos, setXPos] = useState(0);
  const [bottomAnchor, setBottomAnchor] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  // Drag state
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    mx: number;
    my: number;
    ox: number;
    oy: number;
  } | null>(null);

  // Track previous position to detect reopens
  const prevPosRef = useRef<{ x: number; y: number } | null>(null);

  // Compute anchor position. Runs synchronously after render.
  useLayoutEffect(() => {
    if (!isOpen || !position) {
      prevPosRef.current = null;
      return;
    }

    // Reset drag when position changes
    const prev = prevPosRef.current;
    if (!prev || prev.x !== position.x || prev.y !== position.y) {
      setDragPos(null);
    }
    prevPosRef.current = position;

    const rawX = position.x - POPOVER_WIDTH / 2;
    setXPos(
      Math.max(
        MARGIN,
        Math.min(rawX, window.innerWidth - POPOVER_WIDTH - MARGIN),
      ),
    );
    setBottomAnchor(window.innerHeight - position.y + GAP);
    setReady(true);
  }, [isOpen, position]);

  // Hide when closed
  useEffect(() => {
    if (!isOpen) {
      setReady(false);
      setBottomAnchor(null);
    }
  }, [isOpen]);

  // Escape to dismiss
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, dismiss]);

  // Drag handler — reads current rect at drag start so no stale closure issues
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const tag = (e.target as HTMLElement).closest(
      'button, input, textarea, select, [role="button"]',
    );
    if (tag) return;
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      mx: e.clientX,
      my: e.clientY,
      ox: rect.left,
      oy: rect.top,
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      setDragPos({
        x: dragRef.current.ox + ev.clientX - dragRef.current.mx,
        y: dragRef.current.oy + ev.clientY - dragRef.current.my,
      });
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  // Title for each step
  const stepTitle = useMemo(() => {
    if (step === 'intent-select') return 'Intent Recognition';
    const label =
      selectedIndex >= 0
        ? candidates[selectedIndex]?.label
        : customIntent || 'Custom intent';
    return label ?? 'Action Review';
  }, [step, selectedIndex, candidates, customIntent]);

  if (!isOpen || !position) return null;

  // When dragging, use absolute top/left. Otherwise use CSS bottom to
  // anchor the popover's bottom edge — grows upward, no jitter.
  const posStyle: React.CSSProperties = dragPos
    ? { left: dragPos.x, top: dragPos.y, visibility: 'visible', zIndex: 9999 }
    : {
        left: xPos,
        bottom: bottomAnchor ?? 0,
        maxHeight: ready
          ? `calc(100vh - ${(bottomAnchor ?? 0) + MARGIN}px)`
          : undefined,
        overflowY: 'auto',
        visibility: ready ? 'visible' : 'hidden',
        zIndex: 9999,
      };

  return createPortal(
    <div
      ref={containerRef}
      className="border-border fixed w-80 cursor-grab rounded-md border bg-white shadow active:cursor-grabbing"
      style={posStyle}
      onPointerDown={handlePointerDown}
    >
      {/* Title bar */}
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        {step === 'action-review' && (
          <IconButton
            title="Go back"
            className="text-muted-foreground hover:text-foreground flex-shrink-0"
            onClick={goBack}
          >
            <ArrowLeft size={14} />
          </IconButton>
        )}
        <span className="text-foreground/80 min-w-0 flex-1 truncate text-sm">
          {stepTitle}
        </span>
        <IconButton
          title="Close"
          className="text-muted-foreground hover:text-foreground flex-shrink-0 rounded p-0.5"
          onClick={dismiss}
        >
          <X size={14} />
        </IconButton>
      </div>

      {isLoading && step === 'action-review' ? (
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>Resolving actions…</span>
        </div>
      ) : isLoading && step === 'intent-select' ? (
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>Analyzing context…</span>
        </div>
      ) : step === 'intent-select' ? (
        <IntentSelectStep anchorY={position.y} />
      ) : (
        <ActionReviewStep />
      )}
    </div>,
    document.body,
  );
};
