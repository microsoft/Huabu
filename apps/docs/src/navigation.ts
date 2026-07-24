// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Single source of truth for the User Handbook.
 *
 * Authoring rules
 * - `pinned` entries, when present, sit below the logo and search
 *   control in the static top portion of the sidebar and never scroll.
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
  description?: string;
  load: SectionLoader;
};

type RawGroup = {
  label: string;
  items: RawItem[];
};

const pinnedRaw: RawItem[] = [];

const groupsRaw: RawGroup[] = [
  {
    label: 'Getting Started',
    items: [
      {
        to: '/docs',
        label: 'Quick Start',
        description:
          'Install Huabu, create your first Space, add material, and complete your first AI conversation.',
        load: () => import('./sections/QuickStart'),
      },
    ],
  },
  {
    label: 'Spaces',
    items: [
      {
        to: '/docs/work-in-a-space',
        label: 'Work in a Space',
        description:
          'Create, arrange, connect, and inspect the materials and ideas in a Huabu Space.',
        load: () => import('./sections/space/WorkInASpace'),
      },
      {
        to: '/docs/space/data-and-backup',
        label: 'Data & Files',
        description:
          'Understand how Huabu stores each Space as plain files inside your Home folder.',
        load: () => import('./sections/space/DataAndBackup'),
      },
    ],
  },
  {
    label: 'AI',
    items: [
      {
        to: '/docs/work-with-ai',
        label: 'Work with AI',
        description:
          'Choose Chat, Agent, or an Agent Node; provide context; and review AI changes.',
        load: () => import('./sections/ai/WorkWithAI'),
      },
      {
        to: '/docs/ai/agents-and-status',
        label: 'Agents & Status',
        description:
          'Recognize Agent identities, External Agent Profile icons, and Agent Node status.',
        load: () => import('./sections/ai/AgentsAndStatus'),
      },
      {
        to: '/docs/ai/models-and-capabilities',
        label: 'Models & Capabilities',
        description:
          'Configure the Chat and Utility Models and optional web, image, and video capabilities.',
        load: () => import('./sections/ai/ModelsAndCapabilities'),
      },
      {
        to: '/docs/ai/external-agents',
        label: 'External Agents',
        load: () => import('./sections/ai/ExternalAgents'),
      },
      {
        to: '/docs/ai/memory-and-skills',
        label: 'Memory & Skills',
        load: () => import('./sections/ai/MemoryAndSkills'),
      },
    ],
  },
  {
    label: 'Help',
    items: [
      {
        to: '/docs/reference/shortcuts',
        label: 'Keyboard Shortcuts',
        load: () => import('./sections/reference/Shortcuts'),
      },
      {
        to: '/docs/reference/issues',
        label: 'Report an Issue',
        description:
          'Describe a problem, collect useful diagnostic information, and report it through GitHub Issues.',
        load: () => import('./sections/reference/IssueReporting'),
      },
    ],
  },
];

export type DocsItem = {
  /** Absolute path including the `/docs` prefix. */
  to: string;
  label: string;
  description: string;
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
    description:
      item.description ?? `Learn about ${item.label.toLowerCase()} in Huabu.`,
    Component: lazy(item.load),
  };
}

export const pinnedItems: DocsItem[] = pinnedRaw.map(buildItem);

export const groups: DocsGroup[] = groupsRaw.map((group) => ({
  label: group.label,
  items: group.items.map(buildItem),
}));

/**
 * Flat list consumed by `<Routes>` in `DocsPage`.
 */
const allItems: DocsItem[] = [
  ...pinnedItems,
  ...groups.flatMap((g) => g.items),
];

const seen = new Set<string>();
export const allRoutes: DocsItem[] = allItems.filter((item) => {
  if (seen.has(item.to)) {
    throw new Error(`Duplicate handbook route: ${item.to}`);
  }
  seen.add(item.to);
  return true;
});

export const routeManifest = allRoutes.map(({ to, label, description }) => ({
  path: to,
  title: label,
  description,
}));
