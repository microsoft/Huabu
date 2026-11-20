// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { encodeBasis, SPACE_SEARCH_DEFAULT_LIMIT } from '@huabu/shared';

import { searchCanvas } from './canvas-search.js';
import {
  buildCanvasOutline,
  inspectEdges,
  inspectNodes,
} from './canvas-spatial.js';
import {
  snapshotNodesToArtifacts,
  SnapshotNodeError,
} from './snapshot-nodes.js';
import { space } from '../storage/index.js';

import type {
  CanvasSearchMatch,
  SpaceQuery,
  SpaceQueryResponse,
} from '@huabu/shared';

export class SpaceQueryError extends Error {
  constructor(
    message: string,
    readonly code: 'canvas_not_found' | 'query_target_not_found',
  ) {
    super(message);
    this.name = 'SpaceQueryError';
  }
}

function throwQueryError(message: string): never {
  throw new SpaceQueryError(
    message,
    message.startsWith('Canvas ')
      ? 'canvas_not_found'
      : 'query_target_not_found',
  );
}

/**
 * The Space's current read version, or null when the Space does not exist.
 *
 * Callers take it BEFORE reading the state they are about to describe: a
 * write landing in between then makes the basis older than the data, which
 * can only cause an unnecessary rejection later, never a missed one. The
 * first call creates the Space's stamp baseline.
 */
export async function currentBasis(canvasId: string): Promise<string | null> {
  const stamps = await space(canvasId).save.stamps();
  return stamps ? encodeBasis(stamps.lineage, stamps.version) : null;
}

export async function executeSpaceQuery(
  canvasId: string,
  query: SpaceQuery,
): Promise<SpaceQueryResponse> {
  const basis = await currentBasis(canvasId);
  if (basis === null) {
    throw new SpaceQueryError(
      `Canvas ${canvasId} not found`,
      'canvas_not_found',
    );
  }
  switch (query.type) {
    case 'GET_SPACE_OUTLINE': {
      const { type: _type, ...params } = query;
      const result = await buildCanvasOutline(canvasId, params);
      if (!result) {
        throw new SpaceQueryError(
          `Canvas ${canvasId} not found`,
          'canvas_not_found',
        );
      }
      return { type: query.type, result, basis };
    }
    case 'INSPECT_NODES': {
      const { type: _type, ...params } = query;
      const result = await inspectNodes(canvasId, params);
      if ('error' in result) throwQueryError(result.error);
      return {
        type: query.type,
        result,
        basis,
      };
    }
    case 'INSPECT_EDGES': {
      const { type: _type, ...params } = query;
      const result = await inspectEdges(canvasId, params);
      if ('error' in result) throwQueryError(result.error);
      return {
        type: query.type,
        result,
        basis,
      };
    }
    case 'SEARCH': {
      const { type: _type, ...params } = query;
      const request = {
        ...params,
        limit: params.limit ?? SPACE_SEARCH_DEFAULT_LIMIT,
      };
      const matches: Array<{
        tier: 'meta' | 'content' | 'conversation';
        match: CanvasSearchMatch;
      }> = [];
      let truncated = false;
      let error: string | undefined;
      await searchCanvas(space(canvasId), request, (event) => {
        if (event.type === 'match') {
          matches.push({ tier: event.tier, match: event.match });
        } else if (event.type === 'done') {
          truncated = event.truncated;
        } else if (event.type === 'error') {
          error = event.message;
        }
      });
      if (error) {
        throw new SpaceQueryError(
          error,
          error === 'Canvas not found'
            ? 'canvas_not_found'
            : 'query_target_not_found',
        );
      }
      return {
        type: query.type,
        result: { count: matches.length, truncated, matches },
        basis,
      };
    }
    case 'SNAPSHOT_NODES': {
      const { type: _type, ...params } = query;
      try {
        const snapshots = await snapshotNodesToArtifacts({
          canvasId,
          ...params,
        });
        return {
          type: query.type,
          result: {
            snapshots: snapshots.map((snapshot) => ({
              ...snapshot,
              downloadPath: `artifacts/${snapshot.src}`,
            })),
          },
          basis,
        };
      } catch (error) {
        if (error instanceof SnapshotNodeError) {
          throw new SpaceQueryError(
            error.message,
            error.code === 'canvas_not_found'
              ? 'canvas_not_found'
              : 'query_target_not_found',
          );
        }
        throw error;
      }
    }
  }
}
