// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-agnostic block fingerprinting for note provenance.
 *
 * Both the server (authoritative provenance computation) and the web
 * editor (decoration lookup) must agree on a stable per-block key for
 * the SAME logical block, even though they see the markdown in two
 * different shapes:
 *
 *   - The server sees the raw markdown the LLM produced (or the user's
 *     last serialized content).
 *   - The web editor sees markdown after a Milkdown parse → serialize
 *     round-trip, which renormalizes cosmetic syntax (bullet marker
 *     `*` vs `-`, emphasis `_` vs `*`, loose vs tight lists, table
 *     column padding, …).
 *
 * Keying on the raw markdown string would therefore drift between the
 * two hosts. Instead we parse each side's markdown to an mdast tree and
 * fingerprint a NORMALIZED projection of every top-level block: cosmetic
 * fields that differ purely by serializer style (`position`, list
 * `spread`) are dropped, while everything semantic — node type, heading
 * depth, list ordering, inline marks (emphasis / strong / link / …),
 * code language, text — is retained. Two blocks that render the same
 * content hash to the same key regardless of which host produced the
 * markdown.
 *
 * The module is intentionally dependency-light on the engine side: it
 * pulls in the same remark/micromark stack Milkdown uses under the hood,
 * so parsing semantics match.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

import { normalizeMathDelimiters } from './normalizeMathDelimiters.js';

/** Loose mdast node shape — we only ever read a handful of fields. */
interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  position?: unknown;
  [key: string]: unknown;
}

/** A single top-level block plus the source markdown that produced it. */
export interface FingerprintedBlock {
  /** Doc-scoped stable key (with `#N` suffix for duplicates). */
  key: string;
  /** Exact source markdown slice for this block (trimmed). */
  markdown: string;
}

/** Source markdown for each item when the document is one top-level list. */
export function topLevelListItemMarkdown(markdown: string): string[] | null {
  const blocks = parseTopLevel(markdown);
  if (blocks.length !== 1 || blocks[0]?.type !== 'list') return null;

  const items = blocks[0].children ?? [];
  if (items.some((item) => item.type !== 'listItem')) return null;
  return items.map((item) => {
    const pos = item.position as
      | { start?: { offset?: number }; end?: { offset?: number } }
      | undefined;
    const start = pos?.start?.offset;
    const end = pos?.end?.offset;
    return start !== undefined && end !== undefined && end > start
      ? markdown.slice(start, end).trim()
      : '';
  });
}

/* ------------------------------------------------------------------ */
/* Stable stringify + hash (mirrors the legacy PM-JSON fingerprinter)  */
/* ------------------------------------------------------------------ */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/** 32-bit FNV-1a hash, hex-encoded. Doc-scoped identity only. */
function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fields dropped before hashing because they are serializer-style
 * artifacts, NOT semantic content — they differ between raw LLM
 * markdown and Milkdown-normalized markdown for the same block:
 *
 *  - `position`  — source offsets (always differ).
 *  - `spread`    — list / list-item looseness (blank lines between
 *                  items). Milkdown emits loose lists; raw markdown is
 *                  often tight. Same items either way.
 */
const VOLATILE_FIELDS = new Set(['position', 'spread']);

/**
 * True for an mdast `html` node that is just a `<br>` placeholder.
 * Milkdown serializes an EMPTY GFM table cell as `<br />`, whereas raw
 * markdown leaves the cell empty — the two must fingerprint equal.
 */
function isBreakPlaceholder(node: MdastNode): boolean {
  return (
    node.type === 'html' &&
    typeof node.value === 'string' &&
    /^<br\s*\/?>$/i.test(node.value.trim())
  );
}

/**
 * Recursively project an mdast node to a canonical, style-independent
 * form suitable for hashing.
 */
function normalizeMdast(
  node: MdastNode,
  definitions: ReadonlyMap<string, MdastNode>,
): unknown {
  if (node.type === 'linkReference' || node.type === 'imageReference') {
    const identifier =
      typeof node.identifier === 'string' ? node.identifier : undefined;
    const definition = identifier ? definitions.get(identifier) : undefined;
    if (definition) {
      return normalizeMdast(
        node.type === 'linkReference'
          ? {
              type: 'link',
              title: definition.title ?? null,
              url: definition.url,
              children: node.children,
            }
          : {
              type: 'image',
              title: definition.title ?? null,
              url: definition.url,
              alt: node.alt,
            },
        definitions,
      );
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (VOLATILE_FIELDS.has(k)) continue;
    if (k === 'children' && Array.isArray(v)) {
      const kids = (v as MdastNode[])
        .filter((child) => !isBreakPlaceholder(child))
        .map((child) => normalizeMdast(child, definitions));
      // Omit empty children so a cell rendered `<br />` by one host and
      // left blank by the other collapse to the same shape.
      if (kids.length > 0) out.children = kids;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function parseTopLevel(markdown: string): MdastNode[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }) as unknown as MdastNode;
  return tree.children ?? [];
}

/**
 * Compute the bare (un-disambiguated) key for a single top-level mdast
 * block. Two blocks with identical normalized content hash equal.
 */
export function fingerprintMdastBlock(node: MdastNode): string {
  return hash(stableStringify(normalizeMdast(node, new Map())));
}

/**
 * Parse `markdown` and return one {@link FingerprintedBlock} per
 * top-level block, in document order. Duplicate blocks get `#N`
 * suffixes (1-based for the Nth duplicate; first occurrence bare),
 * matching the legacy PM-JSON fingerprinter's disambiguation.
 */
export function fingerprintMarkdownBlocks(
  markdown: string,
): FingerprintedBlock[] {
  const canonicalMarkdown = normalizeMathDelimiters(markdown);
  const parsed = parseTopLevel(canonicalMarkdown);
  const definitions = new Map<string, MdastNode>();
  for (const node of parsed) {
    if (node.type === 'definition' && typeof node.identifier === 'string') {
      definitions.set(node.identifier, node);
    }
  }
  const blocks = parsed.filter((node) => node.type !== 'definition');
  const counts = new Map<string, number>();
  return blocks.map((node) => {
    const base = hash(stableStringify(normalizeMdast(node, definitions)));
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;

    const pos = node.position as
      | { start?: { offset?: number }; end?: { offset?: number } }
      | undefined;
    const start = pos?.start?.offset ?? 0;
    const end = pos?.end?.offset ?? 0;
    const md = end > start ? canonicalMarkdown.slice(start, end).trim() : '';
    return { key, markdown: md };
  });
}

/** Convenience: just the ordered keys for `markdown`. */
export function fingerprintMarkdownKeys(markdown: string): string[] {
  return fingerprintMarkdownBlocks(markdown).map((b) => b.key);
}
