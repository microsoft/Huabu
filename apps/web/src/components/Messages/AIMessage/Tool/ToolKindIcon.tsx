/**
 * Icon for an ACP tool call.
 *
 * Order of resolution:
 *   1. Explicit `toolKind` from the agent (ACP §session/update enum).
 *   2. Built-in internal-tool name (`read`, `grep`, `canvas_commands`,
 *      …) — keeps the same icon the legacy `TOOL_ICON` map showed.
 *   3. Fallback heuristic on the title: classify the leading verb
 *      (`read`, `edit`, `delete`, `move`, `search`, `run` …) so an
 *      external agent that omits `toolKind` still gets a reasonable
 *      glyph instead of a generic dot.
 *   4. Generic `Wrench` for anything we can't classify.
 */

import {
  ArrowRightLeft,
  Sparkle,
  Command,
  Download,
  FolderOpen,
  Workflow,
  Pencil,
  BookOpen,
  Search,
  Settings,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';

import type { AcpToolKind, AssistantToolPart } from '@sediment/shared';

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
  get_canvas_outline: Workflow,
  canvas_commands: Command,
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
  } else if (
    part.internalToolName &&
    INTERNAL_TOOL_ICON[part.internalToolName]
  ) {
    Icon = INTERNAL_TOOL_ICON[part.internalToolName];
  } else {
    Icon = classifyTitle(part.title);
  }
  return <Icon size={size} className={className} />;
}
