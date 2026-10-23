// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

import { literalTextMatches } from '@huabu/shared';
import { markdownSearchTarget } from '@huabu/shared/canvas-engine';

import type { CanvasSearchSource } from '@huabu/shared';
import type { RefObject } from 'react';

interface SearchSource {
  text: string;
  format: 'markdown' | 'text';
  resolveRange?: (text: string, start: number, end: number) => Range | null;
}

const sources = new WeakMap<HTMLElement, SearchSource>();

export async function hashSearchSource(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : (await import('@noble/hashes/sha256')).sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function registerSearchSource(
  root: HTMLElement,
  text: string,
  format: SearchSource['format'],
  resolveRange?: SearchSource['resolveRange'],
): () => void {
  const source = { text, format, resolveRange };
  sources.set(root, source);
  root.setAttribute('data-search-source', '');
  void Promise.resolve()
    .then(() => hashSearchSource(text))
    .then((hash) => {
      if (sources.get(root) !== source) return;
      root.setAttribute('data-search-source', hash);
    })
    .catch((error: unknown) => {
      console.error('[search] Cannot identify rendered source', error);
    });
  return () => {
    if (sources.get(root) !== source) return;
    sources.delete(root);
    root.removeAttribute('data-search-source');
  };
}

export function useSearchSource(
  root: RefObject<HTMLElement | null>,
  text: string,
  format: SearchSource['format'],
  resolver?: RefObject<{
    getSearchRange: NonNullable<SearchSource['resolveRange']>;
  } | null>,
): void {
  useEffect(() => {
    if (!root.current) return;
    return registerSearchSource(
      root.current,
      text,
      format,
      resolver
        ? (...args) => resolver.current?.getSearchRange(...args) ?? null
        : undefined,
    );
  }, [root, text, format, resolver]);
}

export function resolveSourceRange(
  root: HTMLElement,
  query: string,
  address: CanvasSearchSource,
  getTextNodes: (root: HTMLElement) => Node[],
): { range: Range | null; unavailable: boolean } {
  const candidates = [
    root,
    ...root.querySelectorAll<HTMLElement>('[data-search-source]'),
  ].filter(
    (candidate) =>
      candidate.getAttribute('data-search-source') === address.hash &&
      !candidate.closest('[data-preview-active="false"]'),
  );
  if (candidates.length !== 1)
    return { range: null, unavailable: candidates.length > 1 };
  const candidate = candidates[0];
  const source = candidate && sources.get(candidate);
  if (!candidate || !source) return { range: null, unavailable: false };
  const length = address.length ?? query.length;
  let matchesAddress = false;
  for (const match of literalTextMatches(source.text, query)) {
    if (match.start < address.offset) continue;
    matchesAddress =
      match.start === address.offset && match.end === address.offset + length;
    break;
  }
  if (!matchesAddress) {
    return { range: null, unavailable: true };
  }
  const target =
    source.format === 'markdown'
      ? markdownSearchTarget(source.text, address.offset, length)
      : {
          text: source.text,
          start: address.offset,
          end: address.offset + length,
        };
  if (!target) return { range: null, unavailable: true };
  if (source.resolveRange) {
    return {
      range: source.resolveRange(target.text, target.start, target.end),
      unavailable: false,
    };
  }
  const nodes = getTextNodes(candidate);
  // Never guess an ordinal when a node view or normalization changes text.
  if (nodes.map((node) => node.textContent ?? '').join('') !== target.text) {
    return { range: null, unavailable: false };
  }
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const end = offset + (node.textContent?.length ?? 0);
    if (!started && target.start >= offset && target.start < end) {
      range.setStart(node, target.start - offset);
      started = true;
    }
    if (started && target.end > offset && target.end <= end) {
      range.setEnd(node, target.end - offset);
      return { range, unavailable: false };
    }
    offset = end;
  }
  return { range: null, unavailable: true };
}
