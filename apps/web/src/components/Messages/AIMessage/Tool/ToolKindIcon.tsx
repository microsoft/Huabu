// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Icon for an ACP tool call.
 *
 * Order of resolution:
 *   1. Explicit `toolKind` from the agent (ACP §session/update enum).
 *   2. Variant-driven icon for the rich-rendered internal tools
 *      (`space_commands`, `web_search`) and for `agent_tool` parts
 *      keyed by `toolName` — keeps the same icon the legacy
 *      `TOOL_ICON` map showed.
 *   3. Fallback heuristic on the title: classify the leading verb
 *      (`read`, `edit`, `delete`, `move`, `search`, `run` …) so an
 *      external agent that omits `toolKind` still gets a reasonable
 *      glyph instead of a generic dot.
 *   4. Generic `Wrench` for anything we can't classify.
 */

import {
  ArrowRightLeft,
  Sparkle,
  Camera,
  Command,
  Download,
  FolderOpen,
  ImagePlus,
  Workflow,
  Pencil,
  BookOpen,
  Search,
  Settings,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';

import type { AcpToolKind, AssistantToolPart } from '@huabu/shared';

type IconComponent = typeof Wrench;

const KIND_ICON: Record<AcpToolKind, IconComponent> = {
  read: BookOpen,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: Terminal,
  think: Sparkle,
  fetch: Download,
  switch_mode: Settings,
  other: Wrench,
};

const INTERNAL_TOOL_ICON: Record<string, IconComponent> = {
  read: BookOpen,
  grep: Search,
  find: Search,
  ls: FolderOpen,
  inspect_nodes: Workflow,
  inspect_edges: Workflow,
  get_space_outline: Workflow,
  get_canvas_outline: Workflow,
  web_search: Search,
};

/** Heuristic: classify the leading verb of a tool title. */
function classifyTitle(title: string): IconComponent {
  const head = title.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (/^(read|cat|view|open|inspect)$/.test(head)) return BookOpen;
  if (/^(edit|patch|write|update|modify)$/.test(head)) return Pencil;
  if (/^(delete|remove|rm)$/.test(head)) return Trash2;
  if (/^(move|rename|mv)$/.test(head)) return ArrowRightLeft;
  if (/^(search|grep|find|lookup)$/.test(head)) return Search;
  if (/^(run|execute|exec|bash|shell)$/.test(head)) return Terminal;
  if (/^(think|reason|plan)$/.test(head)) return Sparkle;
  if (/^(fetch|download|get)$/.test(head)) return Download;
  if (/^(ls|list)$/.test(head)) return FolderOpen;
  return Wrench;
}

interface ToolKindIconProps {
  part: AssistantToolPart;
  size?: number;
  className?: string;
}

export function ToolKindIcon({
  part,
  size = 12,
  className,
}: ToolKindIconProps) {
  let Icon: IconComponent;
  if (part.toolKind) {
    Icon = KIND_ICON[part.toolKind];
  } else {
    switch (part.variant) {
      case 'space_commands':
        Icon = Command;
        break;
      case 'web_search':
        Icon = Search;
        break;
      case 'image_generation':
        Icon = ImagePlus;
        break;
      case 'snapshot_nodes':
        Icon = Camera;
        break;
      case 'agent_tool':
        Icon = INTERNAL_TOOL_ICON[part.toolName] ?? classifyTitle(part.title);
        break;
      case 'generic':
        Icon = classifyTitle(part.title);
        break;
    }
  }
  return <Icon size={size} className={className} />;
}
