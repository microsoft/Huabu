/**
 * Single source of truth for the User Handbook.
 *
 * Authoring rules
 * - `pinned` entries sit in the static top portion of the sidebar
 *   (logo + Overview + Quick Start) and never scroll.
 * - `groups` are rendered as bold-titled flat lists below the pinned
 *   block, all expanded all the time (no collapse).
 * - Each item declares its full absolute `to` (under `/docs`). This
 *   lets a single sidebar group pull pages from any folder, so we
 *   can regroup the menu without breaking existing URLs.
 * - Section modules are loaded with `React.lazy` so the handbook
 *   never ships in the main bundle.
 */

import { lazy } from 'react';

import type { ComponentType } from 'react';

type SectionLoader = () => Promise<{ default: ComponentType }>;

type RawItem = {
  /** Absolute path under `/docs`, with leading slash. */
  to: string;
  label: string;
  load: SectionLoader;
};

type RawGroup = {
  label: string;
  items: RawItem[];
};

const pinnedRaw: RawItem[] = [
  {
    to: '/docs',
    label: 'Overview',
    load: () => import('./sections/Overview'),
  },
  {
    to: '/docs/quickstart',
    label: 'Quick Start',
    load: () => import('./sections/QuickStart'),
  },
];

const groupsRaw: RawGroup[] = [
  {
    label: 'Core',
    items: [
      {
        to: '/docs/core/externalized-sensemaking',
        label: 'Externalized Sensemaking',
        load: () => import('./sections/core/ExternalizedSensemaking'),
      },
      {
        to: '/docs/core/agentic-canvas',
        label: 'Agentic Canvas',
        load: () => import('./sections/core/AgenticCanvas'),
      },
      {
        to: '/docs/core/acp',
        label: 'Agent Client Protocol',
        load: () => import('./sections/core/Acp'),
      },
      {
        to: '/docs/core/local-first',
        label: 'Local-first & Markdown',
        load: () => import('./sections/core/LocalFirst'),
      },
    ],
  },
  {
    label: 'Demo Cases',
    items: [
      {
        to: '/docs/demos',
        label: 'Overview',
        load: () => import('./sections/demos/Overview'),
      },
      {
        to: '/docs/demos/research-review',
        label: 'Reading a Research Topic',
        load: () => import('./sections/demos/ResearchReview'),
      },
      {
        to: '/docs/demos/product-spec',
        label: 'Drafting a Product Spec',
        load: () => import('./sections/demos/ProductSpec'),
      },
      {
        to: '/docs/demos/brainstorm',
        label: 'Brainstorming a Concept',
        load: () => import('./sections/demos/Brainstorm'),
      },
    ],
  },
  {
    label: 'Work with AI',
    items: [
      {
        to: '/docs/ai/overview',
        label: 'Chat with AI',
        load: () => import('./sections/ai/AskOperate'),
      },
      {
        to: '/docs/ai/intent',
        label: 'Intent & Auto-layout',
        load: () => import('./sections/ai/Intent'),
      },
      {
        to: '/docs/nodes/question',
        label: 'Question Nodes',
        load: () => import('./sections/nodes/Question'),
      },
      {
        to: '/docs/ai/memory',
        label: 'Memory & Skills',
        load: () => import('./sections/ai/Memory'),
      },
      {
        to: '/docs/ai/external-agents',
        label: 'External Agents',
        load: () => import('./sections/ai/ExternalAgents'),
      },
      {
        to: '/docs/ai/context',
        label: 'How AI Sees the Canvas',
        load: () => import('./sections/ai/Context'),
      },
    ],
  },
  {
    label: 'Work in Canvas',
    items: [
      {
        to: '/docs/concepts/workspaces',
        label: 'Workspaces & Canvases',
        load: () => import('./sections/concepts/Workspaces'),
      },
      {
        to: '/docs/concepts/canvas-basics',
        label: 'Canvas Basics',
        load: () => import('./sections/concepts/CanvasBasics'),
      },
      {
        to: '/docs/nodes/overview',
        label: 'Nodes',
        load: () => import('./sections/nodes/Overview'),
      },
      {
        to: '/docs/nodes/edges',
        label: 'Edges & Connections',
        load: () => import('./sections/nodes/Edges'),
      },
      {
        to: '/docs/nodes/frames',
        label: 'Frames',
        load: () => import('./sections/nodes/Frames'),
      },
      {
        to: '/docs/nodes/sketch',
        label: 'Sketch',
        load: () => import('./sections/nodes/Sketch'),
      },
      {
        to: '/docs/nodes/content',
        label: 'Node Content',
        load: () => import('./sections/nodes/Content'),
      },
      {
        to: '/docs/concepts/layers-panel',
        label: 'Layers Panel',
        load: () => import('./sections/concepts/LayersPanel'),
      },
      {
        to: '/docs/concepts/chat-panel',
        label: 'Chat Panel',
        load: () => import('./sections/concepts/ChatPanel'),
      },
    ],
  },
  {
    label: 'Reference',
    items: [
      {
        to: '/docs/reference/shortcuts',
        label: 'Keyboard Shortcuts',
        load: () => import('./sections/reference/Shortcuts'),
      },
      {
        to: '/docs/reference/settings',
        label: 'Settings & LLM',
        load: () => import('./sections/reference/Settings'),
      },
      {
        to: '/docs/reference/storage',
        label: 'Data Storage',
        load: () => import('./sections/reference/Storage'),
      },
      {
        to: '/docs/reference/issues',
        label: 'Reporting Issues',
        load: () => import('./sections/reference/IssueReporting'),
      },
      {
        to: '/docs/reference/changelog',
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

function buildItem(item: RawItem): DocsItem {
  return {
    to: item.to,
    label: item.label,
    Component: lazy(item.load),
  };
}

export const pinnedItems: DocsItem[] = pinnedRaw.map(buildItem);

export const groups: DocsGroup[] = groupsRaw.map((group) => ({
  label: group.label,
  items: group.items.map(buildItem),
}));

/**
 * Flat list consumed by `<Routes>` in `DocsPage`. Deduplicated by
 * URL so a page reused across multiple sidebar groups only
 * registers a single route.
 */
const allItems: DocsItem[] = [
  ...pinnedItems,
  ...groups.flatMap((g) => g.items),
];

const seen = new Set<string>();
export const allRoutes: DocsItem[] = allItems.filter((item) => {
  if (seen.has(item.to)) return false;
  seen.add(item.to);
  return true;
});
