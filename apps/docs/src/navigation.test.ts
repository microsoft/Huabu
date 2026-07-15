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
  it('provides a dedicated Help entry for reporting issues', () => {
    const help = groups.find((group) => group.label === 'Help');
    expect(help?.items.map(({ to, label }) => ({ to, label }))).toEqual([
      { to: '/docs/reference/issues', label: 'Report an Issue' },
    ]);
  });
});
