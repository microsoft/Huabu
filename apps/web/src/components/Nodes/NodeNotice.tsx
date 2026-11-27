// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FileWarning, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';

import './NodeNotice.css';

export interface NodeNoticeAction {
  label: string;
  icon: LucideIcon;
  tone?: 'neutral' | 'danger';
  onClick: (event: React.MouseEvent) => void;
}

export interface NodeNoticeProps {
  /** `warning`: the node is there but its file is not. `danger`: it failed. */
  tone: 'warning' | 'danger';
  title: string;
  description: string;
  actions: NodeNoticeAction[];
  className?: string;
}

const toneClasses = {
  warning: { border: 'border-warning-light', icon: 'text-warning-fg' },
  danger: { border: 'border-danger-light', icon: 'text-danger-fg' },
};

/**
 * The one layout for a problem shown in a node's place: an icon, a title, a
 * line of explanation and the actions that resolve it. It fills its parent
 * and owns both sizes — a centred column, or a single row when the parent is
 * too short for one (an audio node).
 */
export function NodeNotice({
  tone,
  title,
  description,
  actions,
  className,
}: NodeNoticeProps) {
  const { border, icon } = toneClasses[tone];
  return (
    <div
      className={cn('node-notice h-full w-full min-w-0', className)}
      style={{ containerType: 'size' }}
    >
      <div
        className={cn(
          'node-notice__compact bg-surface text-fg-muted h-full w-full min-w-0 items-center gap-2 overflow-hidden rounded-[inherit] border px-2 text-xs',
          border,
        )}
      >
        <FileWarning className={cn('h-3.5 w-3.5 shrink-0', icon)} />
        <span className="min-w-0 flex-1 truncate" title={description}>
          {title}
        </span>
        {actions.map((action) => (
          <Button
            key={action.label}
            size="sm"
            variant="ghost"
            tone={action.tone ?? 'neutral'}
            iconOnly
            title={action.label}
            onClick={action.onClick}
          >
            <action.icon />
          </Button>
        ))}
      </div>
      <div
        className={cn(
          'node-notice__full bg-surface text-fg-muted h-full w-full flex-col items-center justify-center gap-3 rounded-[inherit] border p-4 text-center',
          border,
        )}
      >
        <FileWarning className={cn('h-8 w-8', icon)} />
        <div className="flex max-w-full flex-col gap-1">
          <div className="text-fg-default truncate text-sm font-medium">
            {title}
          </div>
          <div className="text-fg-subtle line-clamp-3 text-xs">
            {description}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant="outline"
              tone={action.tone ?? 'neutral'}
              onClick={action.onClick}
            >
              <action.icon />
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
