/**
 * Layer-panel filter key encoding.
 *
 * The default chip row groups nodes by {@link CanvasNodeType}, but
 * Office nodes are a sub-typed category — three different formats
 * (Word / Excel / PowerPoint) that each carry their own icon on every
 * other surface (canvas card, layer sidebar row, expanded preview
 * breadcrumb). Showing them as a single generic "Office" chip created
 * a visible mismatch with the per-format icons users see in the list
 * below, so the filter is split per format.
 *
 * A {@link LayerFilterKey} is either a plain `CanvasNodeType` or a
 * sub-format discriminator string `office:<format>`. The plain
 * `'office'` token never appears in `availableKeys` — when office
 * nodes are present, only the per-format keys are emitted instead.
 *
 * Encoded as opaque strings (not a union of objects) so the same keys
 * can be used as React list keys and as `Set` members without any
 * structural-equality dance.
 */
import { CANVAS_NODE_TYPES, OFFICE_FORMATS } from '@sediment/shared';

import {
  NODE_ICON,
  NODE_TYPE_LABEL,
  OFFICE_FORMAT_ICON,
} from '@/config/nodeIcons';

import type { CanvasNodeType, OfficeFormat } from '@sediment/shared';
import type { LucideIcon } from 'lucide-react';

export type OfficeFilterKey = `office:${OfficeFormat}`;
export type LayerFilterKey = CanvasNodeType | OfficeFilterKey;

const OFFICE_FORMAT_LABEL: Record<OfficeFormat, string> = {
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
};

export function isOfficeFilterKey(key: string): key is OfficeFilterKey {
  return key.startsWith('office:');
}

export function buildOfficeFilterKey(format: OfficeFormat): OfficeFilterKey {
  return `office:${format}`;
}

/**
 * Returns the icon + tooltip label for a filter key. Office sub-format
 * keys resolve to the same per-format icon the canvas card uses (via
 * {@link OFFICE_FORMAT_ICON}), so the chip row and the list rows stay
 * visually consistent.
 */
export function getFilterKeyMeta(key: LayerFilterKey): {
  icon: LucideIcon;
  label: string;
} {
  if (isOfficeFilterKey(key)) {
    const format = key.slice('office:'.length) as OfficeFormat;
    return {
      icon: OFFICE_FORMAT_ICON[format] ?? NODE_ICON.office,
      label: OFFICE_FORMAT_LABEL[format] ?? NODE_TYPE_LABEL.office,
    };
  }
  return {
    icon: NODE_ICON[key],
    label: NODE_TYPE_LABEL[key],
  };
}

/**
 * Returns true when `node` should pass when `key` is in the filter
 * whitelist. Office sub-format keys additionally require the node's
 * `data.format` to match.
 */
export function nodeMatchesFilterKey(
  type: string | undefined,
  data: Record<string, unknown> | undefined,
  key: LayerFilterKey,
): boolean {
  if (isOfficeFilterKey(key)) {
    if (type !== 'office') return false;
    const wanted = key.slice('office:'.length);
    return data?.['format'] === wanted;
  }
  return type === key;
}

/**
 * Computes the chip-row order. Non-office types follow the canonical
 * {@link CANVAS_NODE_TYPES} order; when office nodes are present we
 * splice in per-format keys (in `OFFICE_FORMATS` order) at the office
 * position so the row stays stable as users add / remove items.
 */
export function buildAvailableFilterKeys(
  presentTypes: ReadonlySet<string>,
  presentOfficeFormats: ReadonlySet<OfficeFormat>,
): LayerFilterKey[] {
  const out: LayerFilterKey[] = [];
  for (const t of CANVAS_NODE_TYPES) {
    if (t === 'office') {
      if (!presentTypes.has('office')) continue;
      for (const fmt of OFFICE_FORMATS) {
        if (presentOfficeFormats.has(fmt)) out.push(buildOfficeFilterKey(fmt));
      }
      continue;
    }
    if (presentTypes.has(t)) out.push(t);
  }
  return out;
}
