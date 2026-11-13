// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlignLeft,
  Check,
  GripVertical,
  Hash,
  List,
  Plus,
  SquareCheck,
} from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { orderedPropertyKeys } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSubmenu,
} from '@/components/Common/DropdownMenu';
import { TextArea } from '@/components/Common/TextArea';
import { TextInput } from '@/components/Common/TextInput';

import {
  PROPERTY_FIELD_CLASS,
  PROPERTY_TAG_CLASS,
  PropertyTagEditor,
  withTag,
} from './PropertyTagEditor';

import type { NodeMetadataPatch } from '@/store/canvasStore';
import type { NodeData } from '@huabu/shared';
import type { ReactNode } from 'react';

type Properties = NonNullable<NodeData['properties']>;
type PropertyValue = Properties[string];
type PropertyKind = 'text' | 'number' | 'boolean' | 'list';
const PROPERTY_ICONS = {
  text: AlignLeft,
  number: Hash,
  boolean: SquareCheck,
  list: List,
};
type PropertyEdit = Pick<
  NodeMetadataPatch,
  'properties' | 'propertyDisplayKeys'
>;

function kindOf(value: PropertyValue): PropertyKind {
  if (Array.isArray(value)) return 'list';
  return typeof value === 'string'
    ? 'text'
    : typeof value === 'number'
      ? 'number'
      : 'boolean';
}

export function propertyText(value: PropertyValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** List values read as neutral tags; other kinds stay plain text. */
function PropertyValueView({ value }: { value: PropertyValue }) {
  if (!Array.isArray(value)) return propertyText(value);
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {value.map((item, index) => (
        <span
          // Lists may repeat a value, so the position disambiguates the key.
          key={`${index}:${item}`}
          data-property-tag
          className={PROPERTY_TAG_CLASS}
        >
          {item}
        </span>
      ))}
    </span>
  );
}

/** Vertical padding of a text value: one 16px line fills the 28px row. */
const PROPERTY_TEXT_PADDING = 'py-1.5';

type Draft = {
  mode: 'add' | 'name' | 'value';
  original?: string;
  name: string;
  /** Field text; for a list, the tag being typed. */
  value: string;
  /** Chosen tags of a list value. */
  items: string[];
  kind: PropertyKind;
};

function PropertyRow({
  name,
  value,
  readOnly,
  disabled,
  editor,
  onEdit,
  onDelete,
  onMove,
  onChangeType,
}: {
  name: string;
  value: PropertyValue;
  readOnly: boolean;
  disabled: boolean;
  editor: ReactNode;
  onEdit: (mode: 'name' | 'value') => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onChangeType: (kind: PropertyKind) => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const Icon = PROPERTY_ICONS[kindOf(value)];
  // Text keeps the same padding shown and edited, on one line or several, so
  // entering the editor never moves it. Tag chips bring their own height.
  const valuePadding = Array.isArray(value) ? 'py-1' : PROPERTY_TEXT_PADDING;
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: name, disabled: readOnly || disabled });

  return (
    <div
      ref={setNodeRef}
      data-property-name={name}
      className={`relative ${isDragging ? 'bg-surface z-10 shadow-sm' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div
        className={`flex min-h-7 items-start gap-3 ${editor ? 'invisible' : ''}`}
        aria-hidden={editor ? true : undefined}
        inert={!!editor}
      >
        <div className="w-28 shrink-0">
          {readOnly ? (
            <span className="text-fg-muted flex min-h-7 items-center gap-1.5 py-1">
              <span
                aria-hidden
                className="flex size-4 shrink-0 items-center justify-center"
              >
                <Icon className="size-3.25" />
              </span>
              <span className="min-w-0 break-words">{name}</span>
            </span>
          ) : (
            <DropdownMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="bottom-left"
              trigger={
                <Button
                  ref={setActivatorNodeRef}
                  {...attributes}
                  {...listeners}
                  variant="ghost"
                  size="sm"
                  className="group/property -ml-1.5 min-h-7 w-[calc(100%+0.75rem)] cursor-grab touch-none justify-start px-1.5 text-left whitespace-normal active:cursor-grabbing enabled:hover:bg-transparent"
                  aria-label={t('node.propertyOptions', { name })}
                  aria-description={t('node.reorderPropertyHint')}
                  disabled={disabled}
                  onKeyDown={(event) => {
                    if (
                      event.altKey &&
                      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      onMove(event.key === 'ArrowUp' ? -1 : 1);
                    }
                  }}
                >
                  <span
                    aria-hidden
                    className="grid size-4 shrink-0 place-items-center [&>svg]:col-start-1 [&>svg]:row-start-1"
                  >
                    <Icon
                      className={
                        disabled
                          ? ''
                          : menuOpen || isDragging
                            ? 'invisible'
                            : 'group-hover/property:invisible group-focus/property:invisible'
                      }
                    />
                    {!disabled && (
                      <GripVertical
                        className={
                          menuOpen || isDragging
                            ? ''
                            : 'invisible group-hover/property:visible group-focus/property:visible'
                        }
                      />
                    )}
                  </span>
                  <span className="min-w-0 break-words">{name}</span>
                </Button>
              }
            >
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onEdit('name');
                }}
              >
                {t('node.renameProperty')}
              </DropdownMenuItem>
              <DropdownMenuSubmenu label={t('node.propertyType')}>
                {(
                  [
                    ['text', 'node.propertyText'],
                    ['number', 'node.propertyNumber'],
                    ['boolean', 'node.propertyBoolean'],
                    ['list', 'node.propertyList'],
                  ] as const
                ).map(([kind, label]) => (
                  <DropdownMenuItem
                    key={kind}
                    role="menuitemradio"
                    aria-checked={kindOf(value) === kind}
                    trailing={
                      kindOf(value) === kind ? <Check size={14} /> : undefined
                    }
                    onClick={() => {
                      setMenuOpen(false);
                      onChangeType(kind);
                    }}
                  >
                    {t(label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubmenu>
              <DropdownMenuItem
                className="text-danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                {t('actions.delete')}
              </DropdownMenuItem>
            </DropdownMenu>
          )}
        </div>
        {readOnly ? (
          <span
            className={`text-fg-default flex min-h-7 min-w-0 flex-1 items-center px-1.5 break-words ${valuePadding}`}
          >
            <PropertyValueView value={value} />
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={`text-fg-default min-h-7 min-w-0 flex-1 justify-start px-1.5 text-left break-words whitespace-normal enabled:hover:bg-transparent ${valuePadding}`}
            aria-label={t('node.editProperty', { name })}
            disabled={disabled}
            onClick={() => onEdit('value')}
          >
            {propertyText(value) ? (
              <PropertyValueView value={value} />
            ) : (
              <span className="text-fg-subtle">{t('node.propertyEmpty')}</span>
            )}
          </Button>
        )}
      </div>
      {editor && <div className="absolute inset-0">{editor}</div>}
    </div>
  );
}

export function NodeProperties({
  properties = {},
  displayKeys = [],
  readOnly,
  tagOptions,
  onSave,
}: {
  properties?: Properties;
  displayKeys?: string[];
  readOnly: boolean;
  /** Known tags for a list property, read when its editor opens. */
  tagOptions?: (name: string) => string[];
  onSave: (patch: PropertyEdit) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const composing = useRef(false);
  const focusCheckbox = useCallback((element: HTMLInputElement | null) => {
    element?.focus();
  }, []);
  const keys = orderedPropertyKeys(properties, displayKeys);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const save = async (patch: PropertyEdit) => {
    if (pending.current || readOnly) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(patch);
      cancelled.current = true;
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const submit = () => {
    if (!draft || pending.current || cancelled.current || composing.current)
      return;
    const name = draft.mode === 'value' ? draft.name : draft.name.trim();
    if (draft.mode === 'add' && !name && !draft.value.trim()) {
      cancelled.current = true;
      setDraft(null);
      setError('');
      return;
    }
    if (!name || (name !== draft.original && Object.hasOwn(properties, name))) {
      setError(t('node.propertiesNameError'));
      return;
    }
    if (draft.mode === 'name' && draft.original) {
      void save({
        properties: {
          ...(name !== draft.original ? { [draft.original]: null } : {}),
          [name]: properties[draft.original],
        },
        propertyDisplayKeys: keys.map((key) =>
          key === draft.original ? name : key,
        ),
      });
      return;
    }
    let value: PropertyValue = draft.value;
    if (draft.kind === 'number') {
      if (!draft.value.trim() || !Number.isFinite(Number(draft.value))) {
        setError(t('node.propertiesNumberError'));
        return;
      }
      value = Number(draft.value);
    } else if (draft.kind === 'boolean') {
      value = draft.value === 'true';
    } else if (draft.kind === 'list') {
      // Text still in the field counts as a tag, so blur never drops it.
      value = withTag(draft.items, draft.value);
    }
    void save({
      properties: { [name]: value },
      ...(draft.mode === 'add' ? { propertyDisplayKeys: [...keys, name] } : {}),
    });
  };
  const edit = (name: string, value: PropertyValue, mode: 'name' | 'value') => {
    cancelled.current = false;
    setError('');
    setDraft({
      mode,
      original: name,
      name,
      kind: kindOf(value),
      value: Array.isArray(value) ? '' : String(value),
      items: Array.isArray(value) ? value : [],
    });
    setOptions(Array.isArray(value) ? (tagOptions?.(name) ?? []) : []);
  };
  const changeType = (name: string, kind: PropertyKind) => {
    const current = properties[name];
    if (kind === kindOf(current)) return;
    const text = Array.isArray(current) ? current.join('\n') : String(current);
    let value: PropertyValue = text;
    if (kind === 'number') {
      if (!text.trim() || !Number.isFinite(Number(text))) {
        setError(t('node.propertiesNumberError'));
        return;
      }
      value = Number(text);
    } else if (kind === 'boolean') {
      if (!['true', 'false', '1', '0'].includes(text.trim().toLowerCase())) {
        setError(t('node.propertiesBooleanError'));
        return;
      }
      value = ['true', '1'].includes(text.trim().toLowerCase());
    } else if (kind === 'list') {
      value = text ? [text] : [];
    }
    void save({ properties: { [name]: value } });
  };
  const reorder = (from: number, to: number) => {
    if (
      draft ||
      pending.current ||
      readOnly ||
      from === to ||
      from < 0 ||
      to < 0 ||
      to >= keys.length
    )
      return;
    void save({ propertyDisplayKeys: arrayMove(keys, from, to) });
  };

  const DraftIcon = PROPERTY_ICONS[draft?.kind ?? 'text'];
  const editor =
    draft && !readOnly ? (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Keep Escape and IME submission inside the property editor.
      <form
        className="grid h-full min-h-7 grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) submit();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            // 229: an IME still owns this key. Safari reports the Enter that
            // confirms a candidate after composition has ended.
            if (
              !event.nativeEvent.isComposing &&
              !composing.current &&
              event.keyCode !== 229
            )
              submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (event.nativeEvent.isComposing || composing.current) return;
            if (!pending.current) {
              cancelled.current = true;
              setDraft(null);
              setError('');
            }
          }
        }}
      >
        {draft.mode === 'value' ? (
          <span className="text-fg-muted flex min-h-7 items-center gap-1.5 py-1">
            <span
              aria-hidden
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <DraftIcon className="size-3.25" />
            </span>
            <span className="min-w-0 break-words">{draft.name}</span>
          </span>
        ) : (
          <div className="flex h-full min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="text-fg-muted flex size-4 shrink-0 items-center justify-center"
            >
              <DraftIcon className="size-3.25" />
            </span>
            <TextInput
              autoFocus
              aria-label={t('node.propertyName')}
              placeholder={t('node.propertyName')}
              value={draft.name}
              disabled={saving}
              className="h-full min-h-0 min-w-0 flex-1 px-1 py-1"
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </div>
        )}
        {draft.mode === 'name' ? (
          <span className="text-fg-default flex min-h-7 min-w-0 items-center px-1.5 py-1 break-words">
            <PropertyValueView value={properties[draft.original ?? '']} />
          </span>
        ) : draft.kind === 'boolean' ? (
          <label className="flex min-h-7 items-center gap-2 px-1.5">
            <input
              ref={focusCheckbox}
              type="checkbox"
              checked={draft.value === 'true'}
              disabled={saving}
              onChange={(event) =>
                setDraft({ ...draft, value: String(event.target.checked) })
              }
            />
            {t('node.propertyValue')}
          </label>
        ) : draft.kind === 'list' ? (
          <PropertyTagEditor
            autoFocus={!!draft.original}
            items={draft.items}
            text={draft.value}
            options={options}
            disabled={saving}
            onChange={({ items, text }) =>
              setDraft({ ...draft, items, value: text })
            }
          />
        ) : draft.kind === 'text' ? (
          // Wraps like the displayed value, so long text is edited in full
          // rather than through a one-line window. Enter still saves.
          <TextArea
            autoFocus={!!draft.original}
            aria-label={t('node.propertyValue')}
            placeholder={t('node.propertyValue')}
            rows={1}
            className={`${PROPERTY_FIELD_CLASS} relative z-10 block [field-sizing:content] min-h-full w-full min-w-0 resize-none overflow-y-auto px-1.5 break-words ${PROPERTY_TEXT_PADDING}`}
            value={draft.value}
            disabled={saving}
            onFocus={(event) => {
              const end = event.currentTarget.value.length;
              event.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(event) =>
              // A pasted line break would be invisible once saved.
              setDraft({
                ...draft,
                value: event.target.value.replace(/\s*\n\s*/g, ' '),
              })
            }
          />
        ) : (
          <TextInput
            autoFocus={!!draft.original}
            aria-label={t('node.propertyValue')}
            placeholder={t('node.propertyValue')}
            className={`${PROPERTY_FIELD_CLASS} h-full min-h-0 w-full min-w-0 px-1.5 py-1`}
            value={draft.value}
            disabled={saving}
            inputMode="decimal"
            onChange={(event) =>
              setDraft({ ...draft, value: event.target.value })
            }
          />
        )}
      </form>
    ) : null;

  return (
    <div className="px-5 pb-3 text-xs" aria-label={t('node.properties')}>
      <DndContext
        sensors={sensors}
        accessibility={{
          screenReaderInstructions: {
            draggable: t('node.reorderPropertyHint'),
          },
        }}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (over)
            reorder(
              keys.indexOf(String(active.id)),
              keys.indexOf(String(over.id)),
            );
        }}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          {keys.map((name, index) => (
            <PropertyRow
              key={name}
              name={name}
              value={
                // While text is edited, the hidden row mirrors the draft so
                // the editor grows and shrinks with what is typed.
                draft?.original === name &&
                draft.mode === 'value' &&
                draft.kind === 'text'
                  ? draft.value
                  : properties[name]
              }
              readOnly={readOnly}
              disabled={saving || draft !== null}
              editor={draft?.original === name && !readOnly ? editor : null}
              onEdit={(mode) => edit(name, properties[name], mode)}
              onMove={(direction) => reorder(index, index + direction)}
              onChangeType={(kind) => changeType(name, kind)}
              onDelete={() =>
                void save({
                  properties: { [name]: null },
                  propertyDisplayKeys: keys.filter((key) => key !== name),
                })
              }
            />
          ))}
        </SortableContext>
      </DndContext>
      {draft && !Object.hasOwn(properties, draft.original ?? '')
        ? editor
        : null}
      {draft?.mode !== 'add' && !readOnly ? (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-1 min-h-7 px-1"
          disabled={saving || draft !== null}
          onClick={() => {
            cancelled.current = false;
            setError('');
            setDraft({
              mode: 'add',
              name: '',
              value: '',
              items: [],
              kind: 'text',
            });
          }}
        >
          <Plus />
          {t('node.addProperty')}
        </Button>
      ) : readOnly && Object.keys(properties).length === 0 ? (
        <p className="text-fg-subtle py-2">{t('node.noProperties')}</p>
      ) : null}
      {error && (
        <p role="alert" className="text-danger mt-2 break-words">
          {error}
        </p>
      )}
    </div>
  );
}
