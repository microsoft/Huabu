import { Check, ChevronRight, RotateCcw } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import useCanvasStore from '@/store/canvasStore';

import type { IntentAction } from '@sediment/shared';

interface AgentChangeListProps {
  prompt: string;
  actions: IntentAction[];
  onUpdateAction: (index: number, updated: IntentAction) => void;
  onKeep: () => void;
  onRevert: () => void;
  disabled?: boolean;
}

interface ActionGroup {
  key: string;
  label: string;
  indices: number[];
}

function buildTempIdMap(actions: IntentAction[]): Map<string, string> {
  const map = new Map<string, string>();
  let idx = 0;

  for (const action of actions) {
    if (action.op === 'ADD_NODE') {
      const placeholder = `$${idx}`;
      const label = action.label
        ? `New "${action.label}"`
        : `New ${action.nodeType} $${idx}`;
      map.set(placeholder, label);
      idx++;
    }
  }

  return map;
}

function nodeNameWithTemp(id: string, tempMap: Map<string, string>): string {
  const temp = tempMap.get(id);
  if (temp) return temp;

  const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
  return (
    ((node?.data as Record<string, unknown>)?.label as string) || id.slice(0, 8)
  );
}

function allNodeOptionsWithTemp(
  tempMap: Map<string, string>,
): Array<{ id: string; label: string }> {
  const real = useCanvasStore.getState().nodes.map((node) => ({
    id: node.id,
    label:
      ((node.data as Record<string, unknown>)?.label as string) ||
      node.id.slice(0, 8),
  }));
  const temp = Array.from(tempMap.entries()).map(([id, label]) => ({
    id,
    label,
  }));
  return [...temp, ...real];
}

function buildActionGroups(actions: IntentAction[]): ActionGroup[] {
  const groups: ActionGroup[] = [];
  let index = 0;

  while (index < actions.length) {
    const op = actions[index].op;
    const indices: number[] = [];

    while (index < actions.length && actions[index].op === op) {
      indices.push(index);
      index++;
    }

    let label = 'Action';
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
        const total = indices.reduce((sum, actionIndex) => {
          const action = actions[actionIndex] as Extract<
            IntentAction,
            { op: 'DELETE_NODES' }
          >;
          return sum + action.nodeIds.length;
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
    }

    groups.push({ key: `${op}-${indices[0]}`, label, indices });
  }

  return groups;
}

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
        <ChevronRight
          size={10}
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
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

const ActionDetails: React.FC<{
  action: IntentAction;
  index: number;
  addNodeIndex: number;
  tempMap: Map<string, string>;
  activePickerId: string | null;
  setActivePickerId: React.Dispatch<React.SetStateAction<string | null>>;
  onUpdateAction: (index: number, updated: IntentAction) => void;
}> = ({
  action,
  index,
  addNodeIndex,
  tempMap,
  activePickerId,
  setActivePickerId,
  onUpdateAction,
}) => {
  const pickerId = useCallback((field: string) => `${index}:${field}`, [index]);

  switch (action.op) {
    case 'ADD_NODE':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <strong>{action.nodeType}</strong>
          {action.label ? ` "${action.label}"` : ''}{' '}
          <span className="text-muted-foreground font-mono text-[10px]">
            {'$'}
            {addNodeIndex}
          </span>
        </div>
      );
    case 'DELETE_NODES':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <span className="inline-flex flex-wrap items-center gap-1">
            {action.nodeIds.map((id, itemIndex) => (
              <React.Fragment key={itemIndex}>
                {itemIndex > 0 && ', '}
                <NodePicker
                  pickerId={pickerId(`delete:${itemIndex}`)}
                  activePickerId={activePickerId}
                  setActivePickerId={setActivePickerId}
                  currentId={id}
                  tempMap={tempMap}
                  onChange={(newId) => {
                    const next = [...action.nodeIds];
                    next[itemIndex] = newId;
                    onUpdateAction(index, { ...action, nodeIds: next });
                  }}
                />
              </React.Fragment>
            ))}
          </span>
        </div>
      );
    case 'CONNECT':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('connect:source')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.sourceId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdateAction(index, { ...action, sourceId: newId })
              }
            />
            {' → '}
            <NodePicker
              pickerId={pickerId('connect:target')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.targetId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdateAction(index, { ...action, targetId: newId })
              }
            />
          </span>
        </div>
      );
    case 'DISCONNECT':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('disconnect:source')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.sourceId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdateAction(index, { ...action, sourceId: newId })
              }
            />
            {' ↛ '}
            <NodePicker
              pickerId={pickerId('disconnect:target')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.targetId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdateAction(index, { ...action, targetId: newId })
              }
            />
          </span>
        </div>
      );
    case 'UPDATE_NODE_DATA':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <NodePicker
            pickerId={pickerId('update-node')}
            activePickerId={activePickerId}
            setActivePickerId={setActivePickerId}
            currentId={action.nodeId}
            tempMap={tempMap}
            onChange={(newId) =>
              onUpdateAction(index, { ...action, nodeId: newId })
            }
          />
        </div>
      );
    case 'GROUP_INTO_FRAME':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <span className="inline-flex flex-wrap items-center gap-1">
            {action.nodeIds.map((id, itemIndex) => (
              <React.Fragment key={itemIndex}>
                {itemIndex > 0 && ', '}
                <NodePicker
                  pickerId={pickerId(`group:${itemIndex}`)}
                  activePickerId={activePickerId}
                  setActivePickerId={setActivePickerId}
                  currentId={id}
                  tempMap={tempMap}
                  onChange={(newId) => {
                    const next = [...action.nodeIds];
                    next[itemIndex] = newId;
                    onUpdateAction(index, { ...action, nodeIds: next });
                  }}
                />
              </React.Fragment>
            ))}
            {action.frameLabel ? ` → "${action.frameLabel}"` : ''}
          </span>
        </div>
      );
    case 'UNFRAME':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <NodePicker
            pickerId={pickerId('unframe')}
            activePickerId={activePickerId}
            setActivePickerId={setActivePickerId}
            currentId={action.frameId}
            tempMap={tempMap}
            onChange={(newId) =>
              onUpdateAction(index, { ...action, frameId: newId })
            }
          />
        </div>
      );
    case 'MOVE_INTO_FRAME':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <span className="inline-flex flex-wrap items-center gap-1">
            <NodePicker
              pickerId={pickerId('move-into:node')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.nodeId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdateAction(index, { ...action, nodeId: newId })
              }
            />
            {' → frame '}
            <NodePicker
              pickerId={pickerId('move-into:frame')}
              activePickerId={activePickerId}
              setActivePickerId={setActivePickerId}
              currentId={action.frameId}
              tempMap={tempMap}
              onChange={(newId) =>
                onUpdateAction(index, { ...action, frameId: newId })
              }
            />
          </span>
        </div>
      );
    case 'MOVE_OUT_OF_FRAME':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <NodePicker
            pickerId={pickerId('move-out')}
            activePickerId={activePickerId}
            setActivePickerId={setActivePickerId}
            currentId={action.nodeId}
            tempMap={tempMap}
            onChange={(newId) =>
              onUpdateAction(index, { ...action, nodeId: newId })
            }
          />
        </div>
      );
    case 'SELECT_NODES':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          <span className="inline-flex flex-wrap items-center gap-1">
            {action.nodeIds.map((id, itemIndex) => (
              <React.Fragment key={itemIndex}>
                {itemIndex > 0 && ', '}
                <NodePicker
                  pickerId={pickerId(`select:${itemIndex}`)}
                  activePickerId={activePickerId}
                  setActivePickerId={setActivePickerId}
                  currentId={id}
                  tempMap={tempMap}
                  onChange={(newId) => {
                    const next = [...action.nodeIds];
                    next[itemIndex] = newId;
                    onUpdateAction(index, { ...action, nodeIds: next });
                  }}
                />
              </React.Fragment>
            ))}
          </span>
        </div>
      );
    case 'ALIGN_NODES':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          {action.direction}
        </div>
      );
    case 'SPREAD_NODES':
      return (
        <div className="text-foreground py-0.5 pl-5 text-xs leading-relaxed">
          spread apart
        </div>
      );
  }
};

export const AgentChangeList = ({
  prompt,
  actions,
  onUpdateAction,
  onKeep,
  onRevert,
  disabled = false,
}: AgentChangeListProps) => {
  const tempMap = useMemo(() => buildTempIdMap(actions), [actions]);
  const groups = useMemo(() => buildActionGroups(actions), [actions]);
  const addNodeIndices = useMemo(() => {
    const indices: number[] = [];
    let counter = 0;

    for (const action of actions) {
      indices.push(action.op === 'ADD_NODE' ? counter++ : -1);
    }

    return indices;
  }, [actions]);

  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(buildActionGroups(actions).map((group) => group.key)),
  );
  const [activePickerId, setActivePickerId] = useState<string | null>(null);

  useEffect(() => {
    setCollapsed(new Set(groups.map((group) => group.key)));
    setActivePickerId(null);
  }, [prompt, groups]);

  const toggleItem = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="border-border rounded-2xl border bg-white p-3">
      <div className="flex items-center justify-between gap-0">
        <div className="text-foreground min-w-0 text-sm font-medium">
          Agent Change List
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="bg-muted hover:bg-muted/80 text-foreground inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onRevert}
            disabled={disabled}
          >
            <RotateCcw size={12} />
            Revert
          </button>
          <button
            type="button"
            className="bg-theme-500 hover:bg-theme-600 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onKeep}
            disabled={disabled}
          >
            <Check size={12} />
            Keep
          </button>
        </div>
      </div>

      <div className="max-h-52 overflow-y-auto py-1">
        {groups.map((group) => (
          <div key={group.key} className="overflow-hidden rounded-md border-0">
            <button
              type="button"
              className="hover:bg-muted flex w-full items-center gap-1 rounded-md p-1 text-left text-xs transition-colors"
              onClick={() => toggleItem(group.key)}
            >
              <ChevronRight
                size={11}
                className={`text-muted-foreground/70 flex-shrink-0 transition-transform ${
                  !collapsed.has(group.key) ? 'rotate-90' : ''
                }`}
              />
              <span className="text-foreground/80 flex-1">{group.label}</span>
            </button>

            {!collapsed.has(group.key) && (
              <div className="pb-0">
                {group.indices.map((index) => (
                  <div key={`${group.key}-${index}`}>
                    {/* <div className="text-muted-foreground px-5 pt-1 text-[11px]">
                      {getIntentActionLabel(actions[index])}
                    </div> */}
                    <ActionDetails
                      action={actions[index]}
                      index={index}
                      addNodeIndex={addNodeIndices[index]}
                      tempMap={tempMap}
                      activePickerId={activePickerId}
                      setActivePickerId={setActivePickerId}
                      onUpdateAction={onUpdateAction}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
