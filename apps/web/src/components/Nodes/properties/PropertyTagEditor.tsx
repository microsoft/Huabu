// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { POPOVER_SURFACE_CLASS } from '@/components/Common/Popover';

/** One outline for every property value editor, whatever its kind. */
export const PROPERTY_FIELD_CLASS =
  'ring-edge-default bg-surface focus-within:ring-info rounded-md border-0 ring-1 ring-inset';

export const PROPERTY_TAG_CLASS =
  'bg-edge-default text-fg-default min-w-0 rounded px-1.5 py-0.5 leading-4 wrap-anywhere';

/** Add `tag` unless it is blank or already present. */
export function withTag(items: readonly string[], tag: string): string[] {
  const value = tag.trim();
  return !value || items.includes(value) ? [...items] : [...items, value];
}

/**
 * Tag picker for one list property: chosen tags, a filter field, and the
 * values already used for this property elsewhere. Typed text that matches no
 * option can be created. The surrounding form owns submit and cancel; Enter
 * reaches it only when there is nothing to add.
 */
export function PropertyTagEditor({
  items,
  text,
  options,
  disabled,
  autoFocus,
  onChange,
}: {
  items: string[];
  text: string;
  /** Known values for this property, in display order. */
  options: readonly string[];
  disabled: boolean;
  autoFocus: boolean;
  onChange: (next: { items: string[]; text: string }) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [cursor, setCursor] = useState<number | null>(null);
  const query = text.trim();
  const needle = query.toLowerCase();
  const matches = options.filter(
    (option) =>
      !items.includes(option) && option.toLowerCase().includes(needle),
  );
  const canCreate =
    query !== '' && !items.includes(query) && !options.includes(query);
  const rows = [
    ...matches.map((value) => ({ value, create: false })),
    ...(canCreate ? [{ value: query, create: true }] : []),
  ];
  // Typed text targets the first row; an empty field targets nothing, so
  // Enter falls through to the form and saves.
  const active =
    cursor !== null && cursor < rows.length
      ? cursor
      : query && rows.length > 0
        ? 0
        : null;
  const add = (tag: string) => {
    // A save is in flight with the list as it was; a change now would be
    // dropped when that save clears the draft.
    if (disabled) return;
    setCursor(null);
    onChange({ items: withTag(items, tag), text: '' });
  };
  // Arrow keys can move the highlight past the list's visible rows.
  useEffect(() => {
    if (active === null) return;
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId]);

  return (
    <div
      className={`${PROPERTY_FIELD_CLASS} relative z-10 min-h-full w-full min-w-0`}
    >
      <div className="flex flex-wrap items-center gap-1 px-1.5 py-1">
        {items.map((item, index) => (
          <span
            // Stored lists may repeat a value; position keeps each chip its own.
            key={`${index}:${item}`}
            data-property-tag
            className={`${PROPERTY_TAG_CLASS} flex items-center gap-0.5`}
          >
            {item}
            <button
              type="button"
              className="text-fg-muted hover:text-fg-default -mr-0.5 flex size-4 shrink-0 items-center justify-center rounded"
              aria-label={t('node.removePropertyTag', { name: item })}
              disabled={disabled}
              // Keep focus in the field so removing a tag does not submit.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                onChange({
                  items: items.filter((_, position) => position !== index),
                  text,
                })
              }
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- Opening the editor is an explicit request to type here.
          autoFocus={autoFocus}
          role="combobox"
          aria-label={t('node.propertyValue')}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            active === null ? undefined : `${listId}-${active}`
          }
          aria-autocomplete="list"
          placeholder={items.length === 0 ? t('node.propertyTagHint') : ''}
          className="text-fg-default placeholder:text-fg-subtle min-w-16 flex-1 bg-transparent py-0.5 leading-4 outline-none"
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setCursor(null);
            onChange({ items, text: event.target.value });
          }}
          onKeyDown={(event) => {
            // 229: an IME is still handling this key (Safari reports the
            // Enter that confirms a composition with isComposing false).
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (rows.length === 0) return;
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setCursor(
                active === null
                  ? step === 1
                    ? 0
                    : rows.length - 1
                  : (active + step + rows.length) % rows.length,
              );
            } else if (event.key === 'Enter' && active !== null) {
              event.preventDefault();
              event.stopPropagation();
              add(rows[active].value);
            } else if (event.key === 'Backspace' && !text && items.length) {
              event.preventDefault();
              onChange({ items: items.slice(0, -1), text });
            }
          }}
        />
      </div>
      {rows.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('node.propertyTagOptions')}
          className={`${POPOVER_SURFACE_CLASS} absolute top-full left-0 z-20 mt-1 max-h-48 w-full min-w-40 overflow-y-auto p-1`}
          // A pointer resting on the list must not turn Enter-to-save into
          // adding whatever it happens to hover.
          onMouseLeave={() => setCursor(null)}
        >
          {rows.map((row, index) => (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- The combobox field owns keyboard selection through aria-activedescendant.
            <li
              key={row.create ? `create:${row.value}` : row.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 ${index === active ? 'bg-hover' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCursor(index)}
              onClick={() => add(row.value)}
            >
              {row.create && (
                <span className="text-fg-muted shrink-0">
                  {t('node.createPropertyTag')}
                </span>
              )}
              <span className={PROPERTY_TAG_CLASS}>{row.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
