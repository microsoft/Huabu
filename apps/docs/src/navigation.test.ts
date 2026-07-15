import { describe, expect, it } from 'vitest';

import { allRoutes, groups, pinnedItems, routeManifest } from './navigation';

describe('handbook route registry', () => {
  it('contains unique /docs routes including node content', () => {
    const paths = allRoutes.map((route) => route.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      paths.every((path) => path === '/docs' || path.startsWith('/docs/')),
    ).toBe(true);
    expect(paths).toContain('/docs/nodes/content');
    expect(paths).not.toContain('/docs/nodes/office');
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
    const usingHuabu = groups.find((group) => group.label === 'Using Huabu');
    expect(usingHuabu?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/work-in-a-space', label: 'Work in a Space' },
    ]);
    expect(
      allRoutes.some(
        (route) =>
          route.to.startsWith('/docs/concepts/') ||
          (route.to.startsWith('/docs/nodes/') &&
            route.to !== '/docs/nodes/content'),
      ),
    ).toBe(false);
  });

  it('does not expose unreleased AI features', () => {
    expect(allRoutes.some((route) => route.to === '/docs/ai/intent')).toBe(
      false,
    );
  });

  it('presents everyday AI work in one task-focused page', () => {
    const workWithAI = groups.find((group) => group.label === 'Work with AI');
    expect(workWithAI?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/work-with-ai', label: 'Work with AI' },
      { to: '/docs/ai/memory', label: 'Memory' },
      { to: '/docs/ai/external-agents', label: 'External Agents' },
    ]);
    expect(
      allRoutes.some((route) =>
        [
          '/docs/ai/chat-mode',
          '/docs/ai/agent-mode',
          '/docs/ai/question-mode',
          '/docs/ai/digest',
          '/docs/ai/skills',
        ].includes(route.to),
      ),
    ).toBe(false);
  });

  it('includes issue reporting in Reference', () => {
    const reference = groups.find((group) => group.label === 'Reference');
    expect(reference?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/reference/shortcuts', label: 'Keyboard Shortcuts' },
      { to: '/docs/reference/settings', label: 'Settings & LLM' },
      { to: '/docs/reference/storage', label: 'Data Storage' },
      { to: '/docs/reference/issues', label: 'Report an Issue' },
    ]);
    expect(groups.some((group) => group.label === 'Help')).toBe(false);
  });
});
