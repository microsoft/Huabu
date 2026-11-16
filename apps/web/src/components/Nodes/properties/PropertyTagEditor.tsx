// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Popover } from '@/components/Common/Popover';

/** One outline for every property value editor, whatever its kind. */
export const PROPERTY_FIELD_CLASS =
  'ring-edge-default bg-surface focus-within:ring-info rounded-md border-0 ring-1 ring-inset';

export const PROPERTY_TAG_CLASS =
  'bg-edge-default text-fg-default min-w-0 rounded px-1.5 py-0.5 leading-4 wrap-anywhere';

/**
 * Add `tag` at `at` (the end when unset) unless it is blank or present.
 * `original` is the stored tag the text came from: left unchanged it goes
 * back even when the list repeats it, so opening a tag never removes it.
 */
export function withTag(
  items: readonly string[],
  tag: string,
  at = items.length,
  original?: string,
): string[] {
  const value = tag.trim();
  return !value || (items.includes(value) && value !== original)
    ? [...items]
    : [...items.slice(0, at), value, ...items.slice(at)];
}

/**
 * Tag picker for one list property: chosen tags, a filter field, and the
 * values already used for this property elsewhere. Typed text that matches no
 * option can be created. Pressing a chosen tag turns it back into text in the
 * field, in place, so it can be corrected. The surrounding form owns submit
 * and cancel; Enter reaches it only when there is nothing to add.
 */
export function PropertyTagEditor({
  items,
  text,
  at,
  editing,
  options,
  disabled,
  autoFocus,
  onChange,
}: {
  items: string[];
  text: string;
  /** Where the typed tag belongs among `items`; the end when unset. */
  at?: number;
  /** The stored tag the text came from, while one is being corrected. */
  editing?: string;
  /** Known values for this property, in display order. */
  options: readonly string[];
  disabled: boolean;
  autoFocus: boolean;
  onChange: (next: {
    items: string[];
    text: string;
    at?: number;
    editing?: string;
  }) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const slot = at ?? items.length;
  const [cursor, setCursor] = useState<number | null>(null);
  const [field, setField] = useState<HTMLDivElement | null>(null);
  const query = text.trim();
  const needle = query.toLowerCase();
  const exact = (option: string) => option.toLowerCase() === needle;
  const matches = options
    .filter(
      (option) =>
        !items.includes(option) && option.toLowerCase().includes(needle),
    )
    // Enter takes the first row: text that names a tag in full must not pick
    // a longer one that merely contains it.
    .sort((a, b) => Number(exact(b)) - Number(exact(a)));
  const canCreate =
    query !== '' && !items.includes(query) && !options.includes(query);
  const rows = [
    ...matches.map((value) => ({ value, create: false })),
    ...(canCreate ? [{ value: query, create: true }] : []),
  ];
  // Typed text targets the first row; an empty field targets nothing, so
  // Enter falls through to the form and saves. So does text that names a
  // tag already chosen: the rows left are other tags that only contain it.
  const active =
    cursor !== null && cursor < rows.length
      ? cursor
      : query && rows.length > 0 && !items.includes(query)
        ? 0
        : null;
  const add = (tag: string) => {
    // A save is in flight with the list as it was; a change now would be
    // dropped when that save clears the draft.
    if (disabled) return;
    setCursor(null);
    onChange({ items: withTag(items, tag, at), text: '' });
  };
  const remove = (index: number) =>
    onChange({
      items: items.filter((_, position) => position !== index),
      text,
      at: at === undefined ? undefined : index < at ? at - 1 : at,
      editing,
    });
  /** Turn the tag at `index` back into field text, keeping what was typed. */
  const edit = (index: number) => {
    if (disabled) return;
    // Lists may repeat a value, so the tag is followed by position, which
    // shifts when the typed text lands before it.
    const typed = withTag(items, text, at, editing);
    const position =
      index + (typed.length > items.length && slot <= index ? 1 : 0);
    // The tag's button is about to go; focus lost there would commit the edit.
    input.current?.focus();
    setCursor(null);
    onChange({
      items: typed.filter((_, other) => other !== position),
      text: items[index],
      at: position,
      editing: items[index],
    });
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
      ref={setField}
      className={`${PROPERTY_FIELD_CLASS} relative z-10 min-h-full w-full min-w-0`}
    >
      <div className="flex flex-wrap items-center gap-1 px-1.5 py-1">
        {items.map((item, index) => (
          <span
            // Stored lists may repeat a value; position keeps each chip its own.
            key={`${index}:${item}`}
            data-property-tag
            className={`${PROPERTY_TAG_CLASS} flex items-center gap-0.5`}
            // The field stays last in the DOM and is placed by `order`: moving
            // a focused input would blur it and commit the edit.
            style={{ order: index < slot ? 0 : 2 }}
          >
            <button
              type="button"
              className="min-w-0 cursor-text text-left wrap-anywhere"
              aria-label={t('node.editPropertyTag', { name: item })}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => edit(index)}
            >
              {item}
            </button>
            <button
              type="button"
              className="text-fg-muted hover:text-fg-default -mr-0.5 flex size-4 shrink-0 items-center justify-center rounded"
              aria-label={t('node.removePropertyTag', { name: item })}
              disabled={disabled}
              // Keep focus in the field so removing a tag does not submit.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => remove(index)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={input}
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
          // Among the tags it is as wide as its text; at the end it takes the
          // rest of the row.
          className={`text-fg-default placeholder:text-fg-subtle order-1 max-w-full bg-transparent py-0.5 leading-4 outline-none ${slot < items.length ? '[field-sizing:content] min-w-4' : 'min-w-16 flex-1'}`}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setCursor(null);
            onChange({ items, text: event.target.value, at, editing });
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
            } else if (event.key === 'Backspace' && !text && slot > 0) {
              event.preventDefault();
              remove(slot - 1);
            }
          }}
        />
      </div>
      {/* Not while saving: nothing can be picked then, and the list floats
          outside the property region, so it would outlive a collapse. */}
      {rows.length > 0 && field && !disabled && (
        // Floats above the page: a Note's properties sit in a short scrolling
        // region that would otherwise clip all but the first option. No
        // dismissal or focus handling: the field keeps focus and the form
        // owns Escape and commit.
        <Popover
          reference={field}
          placement="bottom-start"
          offset={{ x: 0, y: 4 }}
          className="max-h-[min(12rem,var(--popover-available-height))] overflow-y-auto p-1 text-xs"
          style={{ width: field.offsetWidth, minWidth: '10rem' }}
        >
          <ul
            id={listId}
            role="listbox"
            aria-label={t('node.propertyTagOptions')}
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
                // Keep focus in the field: leaving it would commit the edit.
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
        </Popover>
      )}
    </div>
  );
}
