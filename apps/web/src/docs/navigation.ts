/**
 * Single source of truth for the User Handbook.
 *
 * Authoring rules
 * - `pinned` entries sit in the static top portion of the sidebar
 *   (logo + Overview + Quick Start) and never scroll.
 * - `groups` are rendered as bold-titled flat lists below the pinned
 *   block, all expanded all the time (no collapse).
 * - Children inside a group only declare their own URL segment; the
 *   full path is composed against the group's `base` so renaming a
 *   group reroutes the whole subtree for free.
 * - Section modules are loaded with `React.lazy` so the handbook
 *   never ships in the main bundle.
 */

import { lazy } from 'react';

import type { ComponentType } from 'react';

type SectionLoader = () => Promise<{ default: ComponentType }>;

type RawItem = {
  /** URL segment relative to the group's `base` (or to `/docs` for pinned). */
  segment: string;
  label: string;
  load: SectionLoader;
};

type RawGroup = {
  label: string;
  /** Path prefix for items in this group, relative to `/docs`. */
  base: string;
  items: RawItem[];
};

const pinnedRaw: RawItem[] = [
  {
    segment: '',
    label: 'Overview',
    load: () => import('./sections/Overview'),
  },
  {
    segment: 'quickstart',
    label: 'Quick Start',
    load: () => import('./sections/QuickStart'),
  },
];

const groupsRaw: RawGroup[] = [
  {
    label: 'Core Concepts',
    base: 'concepts',
    items: [
      {
        segment: 'workspaces',
        label: 'Workspaces & Canvases',
        load: () => import('./sections/concepts/Workspaces'),
      },
      {
        segment: 'canvas-basics',
        label: 'Canvas Basics',
        load: () => import('./sections/concepts/CanvasBasics'),
      },
      {
        segment: 'layers-panel',
        label: 'Layers Panel',
        load: () => import('./sections/concepts/LayersPanel'),
      },
    ],
  },
  {
    label: 'Nodes & Edges',
    base: 'nodes',
    items: [
      {
        segment: 'overview',
        label: 'Node Types',
        load: () => import('./sections/nodes/Overview'),
      },
      {
        segment: 'frames',
        label: 'Frames',
        load: () => import('./sections/nodes/Frames'),
      },
      {
        segment: 'sketch',
        label: 'Sketch',
        load: () => import('./sections/nodes/Sketch'),
      },
      {
        segment: 'question',
        label: 'Question Nodes',
        load: () => import('./sections/nodes/Question'),
      },
      {
        segment: 'edges',
        label: 'Edges & Connections',
        load: () => import('./sections/nodes/Edges'),
      },
      {
        segment: 'content',
        label: 'Node Content',
        load: () => import('./sections/nodes/Content'),
      },
    ],
  },
  {
    label: 'AI Collaboration',
    base: 'ai',
    items: [
      {
        segment: 'overview',
        label: 'Ask & Operate',
        load: () => import('./sections/ai/AskOperate'),
      },
      {
        segment: 'intent',
        label: 'Intent & Auto-layout',
        load: () => import('./sections/ai/Intent'),
      },
      {
        segment: 'context',
        label: 'How AI Sees the Canvas',
        load: () => import('./sections/ai/Context'),
      },
      {
        segment: 'external-agents',
        label: 'External Agents',
        load: () => import('./sections/ai/ExternalAgents'),
      },
      {
        segment: 'memory',
        label: 'Memory & Skills',
        load: () => import('./sections/ai/Memory'),
      },
    ],
  },
  {
    label: 'Reference',
    base: 'reference',
    items: [
      {
        segment: 'shortcuts',
        label: 'Keyboard Shortcuts',
        load: () => import('./sections/reference/Shortcuts'),
      },
      {
        segment: 'settings',
        label: 'Settings & LLM',
        load: () => import('./sections/reference/Settings'),
      },
      {
        segment: 'storage',
        label: 'Data Storage',
        load: () => import('./sections/reference/Storage'),
      },
      {
        segment: 'changelog',
        label: 'Changelog',
        load: () => import('./sections/reference/Changelog'),
      },
    ],
  },
];

export type DocsItem = {
  /** Absolute path including the `/docs` prefix. */
  to: string;
  label: string;
  Component: ComponentType;
};

export type DocsGroup = {
  label: string;
  items: DocsItem[];
};

function buildItem(item: RawItem, parent: string): DocsItem {
  return {
    to: item.segment ? `${parent}/${item.segment}` : parent,
    label: item.label,
    Component: lazy(item.load),
  };
}

export const pinnedItems: DocsItem[] = pinnedRaw.map((item) =>
  buildItem(item, '/docs'),
);

export const groups: DocsGroup[] = groupsRaw.map((group) => ({
  label: group.label,
  items: group.items.map((item) => buildItem(item, `/docs/${group.base}`)),
}));

/** Flat list consumed by `<Routes>` in `DocsPage`. */
export const allRoutes: DocsItem[] = [
  ...pinnedItems,
  ...groups.flatMap((g) => g.items),
];
