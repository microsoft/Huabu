// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { allRoutes, groups, pinnedItems, routeManifest } from './navigation';

describe('handbook route registry', () => {
  it('contains unique /docs routes', () => {
    const paths = allRoutes.map((route) => route.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      paths.every((path) => path === '/docs' || path.startsWith('/docs/')),
    ).toBe(true);
  });

  it('provides metadata for every route', () => {
    expect(routeManifest).toHaveLength(allRoutes.length);
    expect(
      routeManifest.every((route) => route.title && route.description),
    ).toBe(true);
  });

  it('starts with the task-focused Quick Start', () => {
    expect(pinnedItems).toEqual([]);
    expect(groups[0]?.label).toBe('Getting Started');
    expect(groups[0]?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs', label: 'Quick Start' },
    ]);
    expect(allRoutes.some((route) => route.to === '/docs/showcase')).toBe(
      false,
    );
  });

  it('does not expose product-positioning Core pages', () => {
    expect(groups.some((group) => group.label === 'Core')).toBe(false);
    expect(allRoutes.some((route) => route.to.startsWith('/docs/core/'))).toBe(
      false,
    );
  });

  it('presents Space fundamentals as one task-focused page', () => {
    const spaces = groups.find((group) => group.label === 'Spaces');
    expect(spaces?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/work-in-a-space', label: 'Work in a Space' },
      { to: '/docs/space/data-and-backup', label: 'Data & Files' },
    ]);
    expect(
      allRoutes.some(
        (route) =>
          route.to.startsWith('/docs/concepts/') ||
          route.to.startsWith('/docs/nodes/'),
      ),
    ).toBe(false);
  });

  it('does not expose unreleased AI features', () => {
    expect(allRoutes.some((route) => route.to === '/docs/ai/intent')).toBe(
      false,
    );
  });

  it('presents AI workflow and reference pages', () => {
    const ai = groups.find((group) => group.label === 'AI');
    expect(ai?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/work-with-ai', label: 'Work with AI' },
      {
        to: '/docs/ai/agents-and-status',
        label: 'Agents & Status',
      },
      {
        to: '/docs/ai/models-and-capabilities',
        label: 'Models & Capabilities',
      },
      { to: '/docs/ai/external-agents', label: 'External Agents' },
      { to: '/docs/ai/memory-and-skills', label: 'Memory & Skills' },
    ]);
    expect(
      allRoutes.some((route) =>
        [
          '/docs/ai/chat-mode',
          '/docs/ai/agent-mode',
          '/docs/ai/question-mode',
          '/docs/ai/digest',
          '/docs/ai/models-and-credentials',
        ].includes(route.to),
      ),
    ).toBe(false);
  });

  it('keeps shortcuts and issue reporting in Help', () => {
    const help = groups.find((group) => group.label === 'Help');
    expect(help?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/reference/shortcuts', label: 'Keyboard Shortcuts' },
      { to: '/docs/reference/issues', label: 'Report an Issue' },
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      'Getting Started',
      'Spaces',
      'AI',
      'Help',
    ]);
    expect(
      allRoutes.some((route) =>
        ['/docs/reference/settings', '/docs/reference/storage'].includes(
          route.to,
        ),
      ),
    ).toBe(false);
  });
});
