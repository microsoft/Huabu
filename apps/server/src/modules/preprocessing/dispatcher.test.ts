// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * buildPlan — capability gating tests.
 *
 * Focus: the declarative `capabilityTriggers` + label-protection rules that
 * keep the expensive Enrich (LLM) stage from running when nothing it derives
 * from actually changed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPlan, PreprocessDispatcher } from './dispatcher.js';
import { getProfile } from './profiles.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { PreprocessNodeRequest } from '@huabu/shared';

function req(
  nodeType: PreprocessNodeRequest['nodeType'],
  snapshot: Record<string, unknown>,
  previousSnapshot?: Record<string, unknown>,
  options?: PreprocessNodeRequest['options'],
): PreprocessNodeRequest {
  return {
    canvasId: 'canvas-test',
    nodeId: 'node-test',
    nodeType,
    trigger: previousSnapshot ? 'node_updated' : 'node_inserted',
    snapshot,
    previousSnapshot,
    options,
  };
}

function planFor(request: PreprocessNodeRequest): string[] {
  const profile = getProfile(request.nodeType);
  if (!profile) throw new Error(`no profile for ${request.nodeType}`);
  return buildPlan(profile, request);
}

describe('buildPlan — image label gating', () => {
  it('skips generate_label when a new image already has an agent label', () => {
    const plan = planFor(
      req('image', {
        src: 'artifact-1.png',
        title: '幻灯片 1',
        labelSource: 'agent',
      }),
    );
    expect(plan).not.toContain('generate_label');
    // Structural + persist caps still run.
    expect(plan).toContain('resolve_input');
    expect(plan).toContain('persist_source');
  });

  it('runs generate_label when a new image has no owned label', () => {
    const plan = planFor(req('image', { src: 'artifact-1.png' }));
    expect(plan).toContain('generate_label');
  });

  it('skips generate_label on a label-only edit (src unchanged)', () => {
    const plan = planFor(
      req(
        'image',
        { src: 'artifact-1.png', title: 'Renamed', labelSource: 'user' },
        { src: 'artifact-1.png', title: 'Old', labelSource: 'auto' },
      ),
    );
    expect(plan).not.toContain('generate_label');
  });

  it('runs generate_label when src changes and the label is auto', () => {
    const plan = planFor(
      req(
        'image',
        { src: 'artifact-2.png', title: 'Old', labelSource: 'auto' },
        { src: 'artifact-1.png', title: 'Old', labelSource: 'auto' },
      ),
    );
    expect(plan).toContain('generate_label');
  });
});

describe('buildPlan — pdf enrich gating', () => {
  it('runs full enrich on a fresh pdf', () => {
    const plan = planFor(req('pdf', { src: 'artifact-1.pdf' }));
    expect(plan).toEqual(
      expect.arrayContaining([
        'generate_label',
        'generate_summary',
        'generate_keywords',
      ]),
    );
  });

  it('skips all enrich on a rename (title dirty, src unchanged)', () => {
    const plan = planFor(
      req(
        'pdf',
        { src: 'artifact-1.pdf', title: 'New name', labelSource: 'user' },
        { src: 'artifact-1.pdf', title: 'Old name', labelSource: 'auto' },
      ),
    );
    expect(plan).not.toContain('generate_label');
    expect(plan).not.toContain('generate_summary');
    expect(plan).not.toContain('generate_keywords');
  });

  it('re-enriches summary/keywords when src changes', () => {
    const plan = planFor(
      req(
        'pdf',
        { src: 'artifact-2.pdf', title: 'Old name', labelSource: 'auto' },
        { src: 'artifact-1.pdf', title: 'Old name', labelSource: 'auto' },
      ),
    );
    expect(plan).toEqual(
      expect.arrayContaining(['generate_summary', 'generate_keywords']),
    );
  });
});

describe('buildPlan — office enrich gating', () => {
  it('skips enrich on a rename even though office has no cache short-circuit', () => {
    const plan = planFor(
      req(
        'office',
        { src: 'artifact-1.docx', title: 'New', labelSource: 'user' },
        { src: 'artifact-1.docx', title: 'Old', labelSource: 'auto' },
      ),
    );
    expect(plan).not.toContain('generate_summary');
    expect(plan).not.toContain('generate_label');
  });
});

describe('buildPlan — overrides & unchanged', () => {
  it('force runs the full profile regardless of gating', () => {
    const profile = getProfile('image')!;
    const plan = buildPlan(
      profile,
      req(
        'image',
        { src: 'artifact-1.png', title: '幻灯片 1', labelSource: 'agent' },
        { src: 'artifact-1.png', title: '幻灯片 1', labelSource: 'agent' },
        { force: true },
      ),
    );
    expect(plan).toEqual(profile.capabilities);
  });

  it('runs only structural caps when nothing watched changed', () => {
    const plan = planFor(
      req(
        'image',
        { src: 'artifact-1.png', title: 'Old', labelSource: 'auto' },
        { src: 'artifact-1.png', title: 'Old', labelSource: 'auto' },
      ),
    );
    expect(plan).not.toContain('generate_label');
    expect(plan).toContain('resolve_input');
    expect(plan).toContain('build_patch');
  });
});

describe('PreprocessDispatcher — final topology authority', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'huabu-preprocess-dispatcher-'));
    setWorkspacePath(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function seedNode(topologyType: string): void {
    const store = getCanvasStore('canvas-test');
    store.write({
      canvasId: 'canvas-test',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'node-test',
            type: topologyType,
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('node-test', {
      nodeId: 'node-test',
      type: topologyType,
      label: 'Canonical current label',
      content: 'cached body',
      src: 'document.pdf',
      summary: 'cached summary',
    });
  }

  function expectSanitizedSuperseded(
    result: Awaited<ReturnType<PreprocessDispatcher['preprocess']>>,
  ): void {
    expect(result).toMatchObject({
      success: true,
      status: 'skipped',
      patch: {},
    });
    expect(result.extracted).toBeUndefined();
    expect(result.enriched).toBeUndefined();
    expect(result.persistence).toBeUndefined();
    expect(result.commit).toBeUndefined();
    expect(result.ack).toBeUndefined();
  }

  it('sanitizes a warm-cache result after the node changes type', async () => {
    // A stale PDF request would normally return before Persist through the
    // cache short-circuit. The final topology check must still see that the
    // canonical node is now Office and suppress every stale projection.
    seedNode('office');

    const result = await new PreprocessDispatcher().preprocess(
      req(
        'pdf',
        { src: 'document.pdf', title: 'Stale request label' },
        undefined,
        { allowLLM: false },
      ),
    );

    expectSanitizedSuperseded(result);
    expect(getCanvasStore('canvas-test').read()?.version).toBe(1);
    expect(getCanvasStore('canvas-test').readDeltaLogSince(0)).toEqual([]);
  });

  it('sanitizes a no-persistence result after the node changes type', async () => {
    // allowPersistence:false also bypasses Persist. A stale Note pipeline can
    // still derive a label, but it must not project that label onto the Text
    // node that now owns this id.
    seedNode('text');

    const result = await new PreprocessDispatcher().preprocess(
      req('note', { content: 'Stale heading\nStale body' }, undefined, {
        allowLLM: false,
        allowPersistence: false,
      }),
    );

    expectSanitizedSuperseded(result);
    expect(getCanvasStore('canvas-test').read()?.version).toBe(1);
    expect(getCanvasStore('canvas-test').readDeltaLogSince(0)).toEqual([]);
  });
});
