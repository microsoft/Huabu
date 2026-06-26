import type { ChatAttachment } from '@sediment/shared';

export interface UserMessageMetadata {
  selectedNodeIds?: string[];
  /**
   * Full attachment list for this turn — pass server-internal items
   * (e.g. auto-snapshotted sketches) alongside user-uploaded ones.
   * `appendMetadataTags` will persist only the user-visible subset as
   * a UI breadcrumb and synthesise the LLM hint from the rest.
   */
  attachments?: ChatAttachment[];
  invokedSkills?: string[];
  /**
   * Override the auto-derived hint. Most callers should leave this
   * undefined.
   *
   * LLM-only: the `[SYSTEM hint:…]` tag is always stripped from the
   * persisted user-visible content. `stripMetadataTags` will still
   * decode it back onto `meta.hint` for inspection, but the history
   * rehydration path in `agent.route.ts#buildHistoryItems`
   * deliberately ignores that field, so a hint never re-enters a
   * reconstructed turn — it is consumed once, on the turn that
   * generated it.
   */
  hint?: string;
}

export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type UserContent = string | UserContentPart[];

interface TagSpec<T> {
  encode: (value: T) => string;
  decode: (raw: string) => T | undefined;
  payloadPattern: string;
}

const JSON_ARRAY_LAZY = '\\[.*?\\]';

function decodeStringArray(raw: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed as string[];
    }
  } catch {
    /* malformed payload — caller treats undefined as missing */
  }
  return undefined;
}

function decodeAttachments(raw: string): ChatAttachment[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ChatAttachment[];
  } catch {
    /* malformed payload */
  }
  return undefined;
}

function projectAttachment(a: ChatAttachment): Partial<ChatAttachment> {
  return {
    type: a.type,
    source: a.source,
    ...(a.originNodeId ? { originNodeId: a.originNodeId } : {}),
    ...(a.originNodeIds && a.originNodeIds.length > 0
      ? { originNodeIds: a.originNodeIds }
      : {}),
    ...(a.url ? { url: a.url } : {}),
    ...(a.label ? { label: a.label } : {}),
    ...(a.filename ? { filename: a.filename } : {}),
  };
}

/**
 * Pre-snapshotted sketch artifacts are server-internal: they exist so
 * the LLM can see the strokes as a vision part on the first turn, but
 * they are NOT user-visible references — the user's reference is the
 * underlying stroke nodes carried in `selectedNodeIds`.
 */
function isSketchRasterAttachment(a: ChatAttachment): boolean {
  return (
    a.type === 'image' &&
    typeof a.url === 'string' &&
    a.url.startsWith('sketch-raster-')
  );
}

/**
 * If `attachments` includes pre-snapshotted sketch artifacts, build a
 * one-line directive pointing the agent at those urls so it does not
 * re-issue `snapshot_nodes` for the same node ids on this turn.
 */
function buildSketchRasterHint(
  attachments: ChatAttachment[],
): string | undefined {
  const sketchRasters = attachments.filter(isSketchRasterAttachment);
  if (sketchRasters.length === 0) return undefined;
  const items = sketchRasters
    .map((a) => {
      const ids = a.originNodeIds ?? (a.originNodeId ? [a.originNodeId] : []);
      const shortIds = ids.map((id) => id.slice(0, 13)).join(', ');
      return shortIds ? `${a.url} (nodes: ${shortIds})` : a.url;
    })
    .join('; ');
  return `pre-snapshotted sketch artifacts are ready for generate_image.referenceArtifactSrcs — pass these urls directly without re-calling snapshot_nodes for the same node ids: ${items}`;
}

const TAG_SPECS = {
  selectedNodeIds: {
    encode: (ids: string[]) => JSON.stringify(ids),
    decode: decodeStringArray,
    payloadPattern: JSON_ARRAY_LAZY,
  } satisfies TagSpec<string[]>,

  invokedSkills: {
    encode: (ids: string[]) => JSON.stringify(ids),
    decode: decodeStringArray,
    payloadPattern: JSON_ARRAY_LAZY,
  } satisfies TagSpec<string[]>,

  attachments: {
    encode: (attachments: ChatAttachment[]) =>
      JSON.stringify(attachments.map(projectAttachment)),
    decode: decodeAttachments,
    // Greedy: attachment objects contain `]` inside nested arrays.
    payloadPattern: '\\[.*\\]',
  } satisfies TagSpec<ChatAttachment[]>,

  hint: {
    encode: (text: string) => text,
    decode: (raw: string) => raw,
    payloadPattern: '[^\\]\\n]*',
  } satisfies TagSpec<string>,
} as const;

type TagKey = keyof typeof TAG_SPECS;

// Emit order: UI breadcrumbs first, `hint` last so it sits closest to
// the next assistant turn.
const TAG_ORDER: readonly TagKey[] = [
  'selectedNodeIds',
  'invokedSkills',
  'attachments',
  'hint',
] as const;

/**
 * Filter the full attachment list down to the user-visible subset the
 * UI renders as chips, dropping:
 *   (1) sketch-raster artifacts — server-internal, surfaced to the LLM
 *       only via the `hint` tag, never as a chip;
 *   (2) selection-sourced items whose origin nodes are already carried
 *       by `selectedNodeIds`, because the UI renders one chip per
 *       selected node.
 *
 * Shared by `appendMetadataTags` (tag emission) and the structured
 * history builder (reload), so both agree on which attachments a
 * reloaded user message shows.
 */
export function selectUserVisibleAttachments(
  attachments: ChatAttachment[],
  selectedNodeIds: string[],
): ChatAttachment[] {
  const selectedSet = new Set(selectedNodeIds);
  return attachments.filter((a) => {
    if (isSketchRasterAttachment(a)) return false;
    if (a.source !== 'selection') return true;
    const origin = a.originNodeId ? [a.originNodeId] : (a.originNodeIds ?? []);
    if (origin.length === 0) return true;
    return !origin.every((id) => selectedSet.has(id));
  });
}

/**
 * Project the user-visible attachments to the persisted/display shape
 * (drops bulky `content`, keeps identity + label + url). Used by the
 * history builder so reloaded chips match what the live composer
 * showed.
 */
export function projectUserVisibleAttachments(
  attachments: ChatAttachment[],
  selectedNodeIds: string[],
): Partial<ChatAttachment>[] {
  return selectUserVisibleAttachments(attachments, selectedNodeIds).map(
    projectAttachment,
  );
}

export function appendMetadataTags(
  content: UserContent,
  meta: UserMessageMetadata,
): UserContent {
  // Drop attachments that the UI would render as a duplicate chip
  // (sketch-raster artifacts + selection items already covered by a
  // node chip). See `selectUserVisibleAttachments`.
  const allAttachments = meta.attachments ?? [];
  const userVisibleAttachments = selectUserVisibleAttachments(
    allAttachments,
    meta.selectedNodeIds ?? [],
  );
  const derivedHint =
    meta.hint ?? buildSketchRasterHint(allAttachments) ?? undefined;

  const resolved: UserMessageMetadata = {
    selectedNodeIds: meta.selectedNodeIds,
    invokedSkills: meta.invokedSkills,
    attachments: userVisibleAttachments,
    hint: derivedHint,
  };

  const tags: string[] = [];
  for (const key of TAG_ORDER) {
    const value = resolved[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    const spec = TAG_SPECS[key] as TagSpec<unknown>;
    tags.push(`[SYSTEM ${key}:${spec.encode(value)}]`);
  }

  if (tags.length === 0) return content;
  const joined = `\n${tags.join('\n')}`;
  if (typeof content === 'string') return `${content}${joined}`;
  return [...content, { type: 'text', text: joined }];
}

export function stripMetadataTags(content: string): {
  content: string;
  meta: UserMessageMetadata;
} {
  let remaining = content;
  const meta: UserMessageMetadata = {};

  for (const key of TAG_ORDER) {
    const spec = TAG_SPECS[key] as TagSpec<unknown>;
    const re = new RegExp(
      `\\n?\\[SYSTEM ${key}:(${spec.payloadPattern})\\]`,
      'g',
    );
    const match = re.exec(remaining);
    if (match) {
      const decoded = spec.decode(match[1]);
      if (decoded !== undefined) {
        (meta as Record<string, unknown>)[key] = decoded;
      }
      remaining = remaining.replace(re, '');
    }
  }

  return { content: remaining, meta };
}
