/**
 * Generic renderer for ACP-native tool calls (those without an
 * `internalToolName` escape hatch). External agents — and future
 * built-in pi-ai tools that migrate onto the parts model — surface
 * here with title, status icon, location list, and content blocks.
 *
 * Content-block coverage is deliberately minimal in v1:
 *  - `text`  → render verbatim
 *  - `image` → small inline image
 *  - `diff`  → collapsed "+N / −M" summary
 *  - `terminal` → collapsed "[terminal]" placeholder
 *
 * Permission-gate UI lives elsewhere (the `permission` field is
 * populated by the auto-allow handler today).
 *
 * Visual shell (icon slot, title, chevron, expand/collapse) comes
 * from `AssistantDisclosure` so this card stays aligned with the
 * other assistant sub-cards (`ThinkingCard`, `PreparedPromptMessage`).
 */

import { X as XIcon } from 'lucide-react';

import { ToolKindIcon } from './ToolKindIcon';
import { AssistantDisclosure } from '../../AssistantDisclosure';

import type { AcpContentBlock, GenericToolPart } from '@sediment/shared';

interface ToolCallCardProps {
  part: GenericToolPart;
}

function renderContentBlock(
  block: AcpContentBlock,
  key: number,
): React.ReactNode {
  switch (block.type) {
    case 'text':
      return (
        <pre
          key={key}
          className="text-fg-muted overflow-x-auto rounded-sm px-2 py-1 text-xs whitespace-pre-wrap"
        >
          {block.text}
        </pre>
      );
    case 'image':
      // `data` is base64 per ACP; render via data URL.
      return (
        <img
          key={key}
          src={`data:${block.mimeType ?? 'image/png'};base64,${block.data}`}
          alt={block.uri ?? 'tool image'}
          className="border-edge-default max-w-full rounded-md border"
        />
      );
    case 'resource_link':
      return (
        <a
          key={key}
          href={block.uri}
          target="_blank"
          rel="noopener noreferrer"
          className="text-info text-xs underline"
        >
          {block.name || block.uri}
        </a>
      );
    case 'resource':
      return (
        <span key={key} className="text-fg-subtle text-xs">
          {'text' in block.resource
            ? `[resource: ${block.resource.uri}]`
            : `[binary resource: ${block.resource.uri}]`}
        </span>
      );
    case 'audio':
      return (
        <span key={key} className="text-fg-subtle text-xs">
          [audio attachment]
        </span>
      );
    default:
      return null;
  }
}

export function ToolCallCard({ part }: ToolCallCardProps) {
  const hasContent = (part.content?.length ?? 0) > 0;
  const hasLocations = (part.locations?.length ?? 0) > 0;
  const isExpandable = hasContent || hasLocations;

  // Render content blocks. ACP's ToolCallContent union has three
  // top-level variants; we narrow then forward inner content blocks
  // to the per-block renderer.
  const renderedContent: React.ReactNode[] = [];
  if (hasContent) {
    part.content!.forEach((wrap, i) => {
      if (wrap.type === 'content') {
        renderedContent.push(renderContentBlock(wrap.content, i));
      } else if (wrap.type === 'diff') {
        renderedContent.push(
          <div
            key={`diff-${i}`}
            className="text-fg-subtle bg-bg-default rounded-sm px-2 py-1 text-xs"
          >
            [diff: {wrap.path}]
          </div>,
        );
      } else {
        renderedContent.push(
          <div
            key={`term-${i}`}
            className="text-fg-subtle bg-bg-default rounded-sm px-2 py-1 text-xs"
          >
            [terminal]
          </div>,
        );
      }
    });
  }

  const icon =
    part.status === 'failed' ? (
      <XIcon size={12} className="text-danger" />
    ) : (
      <ToolKindIcon part={part} className="text-fg-muted/60" />
    );

  const body = isExpandable ? (
    <>
      {hasLocations && (
        <ul className="text-fg-subtle text-xs">
          {part.locations!.map((loc, i) => (
            <li key={`loc-${i}`} className="truncate">
              {loc.path}
              {loc.line ? `:${loc.line}` : ''}
            </li>
          ))}
        </ul>
      )}
      {renderedContent}
    </>
  ) : undefined;

  return (
    <AssistantDisclosure
      icon={icon}
      title={part.title}
      bodyClassName="border-edge-default/40 ml-4 flex flex-col gap-1 border-l py-1 pl-3"
    >
      {body}
    </AssistantDisclosure>
  );
}
