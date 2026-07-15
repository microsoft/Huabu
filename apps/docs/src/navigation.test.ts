import { describe, expect, it } from 'vitest';

import { allRoutes, routeManifest } from './navigation';

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
});
