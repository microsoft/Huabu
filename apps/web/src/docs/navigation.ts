/**
 * Single source of truth for the User Handbook.
 *
 * Authoring rules
 * - `pinned` entries sit in the static top portion of the sidebar
 *   (logo + Overview + Quick Start + Showcase) and never scroll.
 * - `groups` are rendered as bold-titled flat lists below the pinned
 *   block, all expanded all the time (no collapse).
 * - Each item declares its full absolute `to` (under `/docs`). This
 *   lets a single sidebar group pull pages from any folder, so we
 *   can regroup the menu without breaking existing URLs.
 * - The same component module may be referenced from more than one
 *   sidebar URL (e.g. the Question node appears under both "Work with AI"
 *   as "Question Mode" and under "Work in Canvas" as "Question Node");
 *   `allRoutes` is deduplicated by URL so each path registers exactly
 *   one `<Route>`.
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
  {
    to: '/docs/showcase',
    label: 'Showcase',
    load: () => import('./sections/Showcase'),
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
        to: '/docs/core/pluggable-agents',
        label: 'Pluggable Agents',
        load: () => import('./sections/core/PluggableAgents'),
      },
      {
        to: '/docs/core/open-vault',
        label: 'Open Vault',
        load: () => import('./sections/core/OpenVault'),
      },
    ],
  },
  {
    label: 'Work with AI',
    items: [
      {
        to: '/docs/ai/chat-mode',
        label: 'Chat Mode',
        load: () => import('./sections/ai/ChatMode'),
      },
      {
        to: '/docs/ai/agent-mode',
        label: 'Agent Mode',
        load: () => import('./sections/ai/AgentMode'),
      },
      {
        to: '/docs/ai/question-mode',
        label: 'Question Mode',
        load: () => import('./sections/nodes/Question'),
      },
      {
        to: '/docs/ai/intent',
        label: 'Intent',
        load: () => import('./sections/ai/Intent'),
      },
      {
        to: '/docs/ai/digest',
        label: 'Digest',
        load: () => import('./sections/ai/Digest'),
      },
      {
        to: '/docs/ai/memory',
        label: 'Memory',
        load: () => import('./sections/ai/Memory'),
      },
      {
        to: '/docs/ai/skills',
        label: 'Skills',
        load: () => import('./sections/ai/Skills'),
      },
      {
        to: '/docs/ai/external-agents',
        label: 'External Agents',
        load: () => import('./sections/ai/ExternalAgents'),
      },
    ],
  },
  {
    label: 'Work in Canvas',
    items: [
      {
        to: '/docs/concepts/workspaces',
        label: 'Workspaces',
        load: () => import('./sections/concepts/Workspaces'),
      },
      {
        to: '/docs/concepts/canvas-basics',
        label: 'Canvas',
        load: () => import('./sections/concepts/CanvasBasics'),
      },
      {
        to: '/docs/nodes/note',
        label: 'Note Node',
        load: () => import('./sections/nodes/Note'),
      },
      {
        to: '/docs/nodes/text',
        label: 'Text Node',
        load: () => import('./sections/nodes/Text'),
      },
      {
        to: '/docs/nodes/image',
        label: 'Image Node',
        load: () => import('./sections/nodes/Image'),
      },
      {
        to: '/docs/nodes/pdf',
        label: 'PDF Node',
        load: () => import('./sections/nodes/Pdf'),
      },
      {
        to: '/docs/nodes/video',
        label: 'Video Node',
        load: () => import('./sections/nodes/Video'),
      },
      {
        to: '/docs/nodes/web',
        label: 'Web Node',
        load: () => import('./sections/nodes/Web'),
      },
      {
        to: '/docs/nodes/frames',
        label: 'Frame Node',
        load: () => import('./sections/nodes/Frames'),
      },
      {
        to: '/docs/nodes/sketch',
        label: 'Sketch Node',
        load: () => import('./sections/nodes/Sketch'),
      },
      {
        to: '/docs/nodes/question',
        label: 'Question Node',
        load: () => import('./sections/nodes/Question'),
      },
      {
        to: '/docs/nodes/edges',
        label: 'Edges',
        load: () => import('./sections/nodes/Edges'),
      },
      {
        to: '/docs/concepts/alignment',
        label: 'Layout & Alignment',
        load: () => import('./sections/concepts/Alignment'),
      },
      {
        to: '/docs/concepts/semantic-zoom',
        label: 'Semantic Zoom',
        load: () => import('./sections/concepts/SemanticZoom'),
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
 * URL so a page reused across multiple sidebar groups only registers
 * a single route. Also keeps a route registered for `/docs/nodes/overview`
 * (linked from the Overview hub but not present in the sidebar) and
 * `/docs/ai/question-mode`, which reuses the existing Question node
 * component under a different URL.
 */
const allItems: DocsItem[] = [
  ...pinnedItems,
  ...groups.flatMap((g) => g.items),
  buildItem({
    to: '/docs/nodes/overview',
    label: 'Nodes',
    load: () => import('./sections/nodes/Overview'),
  }),
];

const seen = new Set<string>();
export const allRoutes: DocsItem[] = allItems.filter((item) => {
  if (seen.has(item.to)) return false;
  seen.add(item.to);
  return true;
});
