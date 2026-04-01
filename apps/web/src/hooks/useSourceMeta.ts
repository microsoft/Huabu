import { useEffect, useState } from 'react';

import { getSource } from '@/api/knowledge';

import type { SourceMetadata } from '@sediment/shared';

interface SourceMeta {
  summary: string | null;
  keywords: string[] | null;
}

const EMPTY: SourceMeta = { summary: null, keywords: null };

// Simple in-memory cache shared by all hook consumers.
// Uses Map insertion order for LRU-style eviction when the cap is exceeded.
const MAX_CACHE_SIZE = 200;
const cache = new Map<string, SourceMeta>();

function cacheSet(key: string, value: SourceMeta): void {
  // Move to end (most-recently used) by re-inserting
  cache.delete(key);
  cache.set(key, value);
  // Evict oldest entries if over limit
  if (cache.size > MAX_CACHE_SIZE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

function parseMeta(metaJson: string | null | undefined): SourceMeta {
  if (!metaJson) return EMPTY;
  try {
    const meta = JSON.parse(metaJson) as SourceMetadata;
    const summary =
      typeof meta.summary === 'string' && meta.summary.trim()
        ? meta.summary.trim()
        : null;
    const keywords =
      Array.isArray(meta.keywords) && meta.keywords.length > 0
        ? meta.keywords
        : null;
    return { summary, keywords };
  } catch {
    return EMPTY;
  }
}

/**
 * Fetch and cache source metadata (summary + keywords) for a given sourceId.
 * Returns `{ summary, keywords }` — both null while loading or if unavailable.
 */
export function useSourceMeta(sourceId: string | null | undefined): SourceMeta {
  const [meta, setMeta] = useState<SourceMeta>(() => {
    if (!sourceId) return EMPTY;
    return cache.get(sourceId) ?? EMPTY;
  });

  useEffect(() => {
    if (!sourceId) {
      setMeta(EMPTY);
      return;
    }

    // Serve from cache immediately
    const cached = cache.get(sourceId);
    if (cached) {
      setMeta(cached);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const source = await getSource(sourceId);
        if (cancelled) return;
        const parsed = parseMeta(source.metaJson);
        cacheSet(sourceId, parsed);
        setMeta(parsed);
      } catch {
        if (!cancelled) setMeta(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  return meta;
}
